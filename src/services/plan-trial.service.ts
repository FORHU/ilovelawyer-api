import type { PaymentPlanSubscriptionStatus, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import NotificationSvc from "./notification.service";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";
import { emailLinkOriginForAccount } from "../utils/tenant-host";
import { DAY_MS, PLAN_TRIAL_REMINDER_DAYS, PLANS_PAGE_PATH } from "../constants/plan-trial.constants";
import logger from "../utils/logger";

/** A lawyer who has ever subscribed isn't told about a trial: once a subscription ends, the account
 * is locked by having no tier (AccountLimitsSvc), and "your trial has ended" would be wrong. */
const EVER_SUBSCRIBED: PaymentPlanSubscriptionStatus[] = ["ACTIVE", "PAST_DUE", "CANCELED"];

/** Most accounts one sweep handles per step; the next run picks up the rest. */
const BATCH = 200;

const TIME_ZONES: Record<string, string> = { UK: "Europe/London", PH: "Asia/Manila" };

const USER_SELECT = { id: true, email: true, planTrialEndsAt: true, tenant: { select: { code: true } } } satisfies Prisma.UserSelect;

type TrialUser = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

/** The day, in the lawyer's own region: "Friday 6 November 2026". */
function formatDay(date: Date, tenantCode: string | undefined): string {
  return date.toLocaleDateString("en-GB", { dateStyle: "full", timeZone: TIME_ZONES[tenantCode ?? ""] ?? "Europe/London" });
}

/** The lawyer app's plans page, on the account's own region. */
function plansLink(user: TrialUser): string {
  return `${emailLinkOriginForAccount({ role: "LAWYER", tenant: user.tenant }, null)}${PLANS_PAGE_PATH}`;
}

/** Accounts still on a trial that nobody pays for: approved, not being deleted, never subscribed. */
const unpaidTrial = (planTrialEndsAt: Prisma.DateTimeNullableFilter): Prisma.UserWhereInput => ({
  role: "LAWYER",
  approvalStatus: "ACTIVE",
  deletionRequestedAt: null,
  planTrialEndsAt,
  paymentPlanSubscriptions: { none: { status: { in: EVER_SUBSCRIBED } } },
});

/**
 * Telling a solo lawyer about their free trial of their tier (User.planTrialEndsAt, started by
 * AuthRepo.startPlanTrial): an email and an in-app notification PLAN_TRIAL_REMINDER_DAYS before it
 * ends, and another once it has, both linking to the lawyer app's plans page. The lock itself is
 * AccountLimitsSvc's. Each message goes once per account, fenced on its own column before it is
 * sent, so overlapping runs never send it twice; run by PlanTrialSweepQueue.
 */
export default class PlanTrialSvc {
  /** "Your trial ends on …" to each lawyer within PLAN_TRIAL_REMINDER_DAYS of the end. How many. */
  static async remindDue(now: Date = new Date()): Promise<number> {
    const users = await prisma.user.findMany({
      where: { ...unpaidTrial({ gt: now, lte: new Date(now.getTime() + PLAN_TRIAL_REMINDER_DAYS * DAY_MS) }), planTrialReminderSentAt: null },
      select: USER_SELECT,
      take: BATCH,
    });
    let sent = 0;
    for (const user of users) {
      try {
        const { count } = await prisma.user.updateMany({ where: { id: user.id, planTrialReminderSentAt: null }, data: { planTrialReminderSentAt: now } });
        if (count !== 1) continue;
        const endsOn = formatDay(user.planTrialEndsAt!, user.tenant?.code);
        const link = plansLink(user);
        await NotificationSvc.create({
          userId: user.id,
          type: "SYSTEM",
          title: "Your free trial ends soon",
          message: `Your free trial ends on ${endsOn}. Choose a plan to keep using the AI and creating cases after that.`,
          link: PLANS_PAGE_PATH,
        });
        const html = await renderTemplate("plan-trial-ending", { endsOn, plansLink: link });
        const text = `Your free trial ends on ${endsOn}. After that your account becomes read-only: you can still open everything, but you won't be able to use the AI or create cases until you choose a plan.\n\nChoose a plan: ${link}`;
        await sendEmail({ to: user.email, subject: "Your free trial ends soon", text, html }).catch((err) => logger.error("Plan trial: reminder email failed", { err, userId: user.id }));
        sent++;
      } catch (err) {
        logger.error("Plan trial: reminder failed", { err, userId: user.id });
      }
    }
    return sent;
  }

  /** "Your trial has ended" to each lawyer whose trial is over, once. How many. */
  static async announceEnded(now: Date = new Date()): Promise<number> {
    const users = await prisma.user.findMany({
      where: { ...unpaidTrial({ lte: now }), planTrialEndedNotifiedAt: null },
      select: USER_SELECT,
      take: BATCH,
    });
    let sent = 0;
    for (const user of users) {
      try {
        const { count } = await prisma.user.updateMany({ where: { id: user.id, planTrialEndedNotifiedAt: null }, data: { planTrialEndedNotifiedAt: now } });
        if (count !== 1) continue;
        const link = plansLink(user);
        await NotificationSvc.create({
          userId: user.id,
          type: "SYSTEM",
          title: "Your free trial has ended",
          message: "Your account is read-only for now. Choose a plan to keep using the AI and creating cases; everything you made is still there.",
          link: PLANS_PAGE_PATH,
        });
        const html = await renderTemplate("plan-trial-ended", { plansLink: link });
        const text = `Your free trial has ended, so your account is read-only for now: you can still open everything, but not use the AI or create cases. Choose a plan to keep going; your cases and documents are all still there.\n\nChoose a plan: ${link}`;
        await sendEmail({ to: user.email, subject: "Your free trial has ended", text, html }).catch((err) => logger.error("Plan trial: ended email failed", { err, userId: user.id }));
        sent++;
      } catch (err) {
        logger.error("Plan trial: ended notice failed", { err, userId: user.id });
      }
    }
    return sent;
  }
}
