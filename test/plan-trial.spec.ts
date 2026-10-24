/** A solo lawyer's 14-day free trial of their tier: it starts once the account is approved and solo
 * (AuthRepo.startPlanTrial), its end locks the account read-only until a subscription is live
 * (AccountLimitsSvc, the top-up checkout), and the "ends soon" and "has ended" messages go once each
 * (PlanTrialSvc). Against the real local Postgres; email and notifications are stubbed. */
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import crypto from "crypto";
import prisma from "../src/lib/prisma";
import AuthRepo from "../src/repositories/auth.repository";
import AccountLimitsSvc from "../src/services/account-limits.service";
import AccountTopUpBillingSvc from "../src/services/account-topup-billing.service";
import PaymentPlanBillingSvc from "../src/services/payment-plan-billing.service";
import PlanTrialSvc from "../src/services/plan-trial.service";
import NotificationSvc from "../src/services/notification.service";
import * as mailer from "../src/utils/mailer";
import { DAY_MS, PLAN_TRIAL_DAYS } from "../src/constants/plan-trial.constants";

async function errorOf(promise: Promise<unknown>): Promise<{ status?: number; code?: string } | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err: any) {
    return { status: err.statusCode, code: err.code };
  }
}

const NOW = new Date("2026-11-10T09:00:00Z");
const daysFrom = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

describe("Solo lawyer plan trial", () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const ids: string[] = [];
  let tenantId: string;
  let planId: string;
  let emails: { to: string; subject: string }[];
  let notifications: { userId: string; title: string; link?: string }[];
  let restore: (() => void)[];

  const emailOf = (id: string) => `trial-spec-${tag}-${id}@example.com`;

  /** A lawyer row, solo and approved unless told otherwise. */
  async function lawyer(data: Record<string, unknown> = {}) {
    const id = crypto.randomUUID();
    ids.push(id);
    await prisma.user.create({
      data: {
        id,
        email: emailOf(id),
        username: `trial-spec-${tag}-${ids.length}`,
        role: "LAWYER",
        tenantId,
        paymentPlanId: planId,
        approvalStatus: "ACTIVE",
        soloChosenAt: new Date(),
        ...data,
      },
    });
    return id;
  }

  const trialOf = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id }, select: { planTrialEndsAt: true } })).planTrialEndsAt;
  const subscribe = (userId: string, status: "ACTIVE" | "CANCELED" = "ACTIVE") =>
    prisma.paymentPlanSubscription.create({ data: { userId, paymentPlanId: planId, provider: "DUMMY", status } });

  before(async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { code: "UK" }, select: { id: true } });
    tenantId = tenant.id;
    const plan = await prisma.paymentPlan.findFirstOrThrow({ where: { tenantId, planType: "B2B_SUBSCRIPTION" }, orderBy: { level: "asc" }, select: { id: true } });
    planId = plan.id;
  });

  beforeEach(() => {
    emails = [];
    notifications = [];
    const sendEmail = mailer.sendEmail;
    const create = NotificationSvc.create;
    (mailer as any).sendEmail = async (mail: { to: string; subject: string }) => (emails.push(mail), "sent");
    (NotificationSvc as any).create = async (input: any) => (notifications.push(input), input);
    restore = [() => ((mailer as any).sendEmail = sendEmail), () => ((NotificationSvc as any).create = create)];
  });
  afterEach(() => restore.forEach((r) => r()));

  after(async () => {
    await prisma.paymentPlanSubscription.deleteMany({ where: { userId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  describe("starting", () => {
    it("starts 14 days from the moment a solo lawyer is approved, once", async () => {
      const id = await lawyer({ approvalStatus: "PENDING" });
      await AuthRepo.startPlanTrial(id, NOW);
      expect(await trialOf(id)).to.equal(null);

      await prisma.user.update({ where: { id }, data: { approvalStatus: "ACTIVE" } });
      await AuthRepo.startPlanTrial(id, NOW);
      expect(await trialOf(id)).to.deep.equal(daysFrom(NOW, PLAN_TRIAL_DAYS));

      // Approved again later (unblocked, say): the trial doesn't restart.
      await AuthRepo.startPlanTrial(id, daysFrom(NOW, 30));
      expect(await trialOf(id)).to.deep.equal(daysFrom(NOW, PLAN_TRIAL_DAYS));
    });

    it("starts on approval, and on choosing solo when the account was approved first", async () => {
      const approvedLater = await lawyer({ approvalStatus: "PENDING" });
      await AuthRepo.setApprovalStatus(approvedLater, "ACTIVE", null);
      expect(await trialOf(approvedLater)).to.be.instanceOf(Date);

      const soloLater = await lawyer({ soloChosenAt: null });
      await AuthRepo.startPlanTrial(soloLater);
      expect(await trialOf(soloLater)).to.equal(null);
      await AuthRepo.setSoloChosen(soloLater);
      expect(await trialOf(soloLater)).to.be.instanceOf(Date);
    });

    it("never starts for a firm lawyer, a guest, a lawyer already paying, or a client", async () => {
      const firm = await lawyer({ soloChosenAt: null });
      const guest = await lawyer({ trialExpiresAt: daysFrom(NOW, 1) });
      const paying = await lawyer();
      await subscribe(paying);
      const client = await lawyer({ role: "USER" });
      for (const id of [firm, guest, paying, client]) {
        await AuthRepo.startPlanTrial(id, NOW);
        expect(await trialOf(id)).to.equal(null);
      }
    });
  });

  describe("when it ends", () => {
    it("leaves the account open during the trial", async () => {
      const id = await lawyer({ planTrialEndsAt: daysFrom(new Date(), 2) });
      expect(await errorOf(AccountLimitsSvc.assertCanCreateCase(id))).to.equal(undefined);
      expect(await errorOf(AccountLimitsSvc.assertAccountHasBudget(id))).to.equal(undefined);
      expect((await AccountLimitsSvc.allowanceInfo(id)).trialEnded).to.equal(false);
    });

    it("then locks it read-only: no AI, no new case, no top-up", async () => {
      const id = await lawyer({ planTrialEndsAt: daysFrom(new Date(), -1), extraAiAllowanceUsd: 50 });
      expect(await errorOf(AccountLimitsSvc.assertCanCreateCase(id))).to.deep.equal({ status: 403, code: "PLAN_TRIAL_ENDED" });
      expect(await errorOf(AccountLimitsSvc.assertAccountHasBudget(id))).to.deep.equal({ status: 403, code: "PLAN_TRIAL_ENDED" });
      expect(await errorOf(AccountTopUpBillingSvc.startCheckout(id, 10, undefined))).to.deep.equal({ status: 409, code: "PLAN_TRIAL_ENDED" });
      expect(await AccountLimitsSvc.allowanceInfo(id)).to.include({ locked: true, trialEnded: true });

      const options = await PaymentPlanBillingSvc.options(id);
      expect(options).to.include({ subscribed: false, trialEnded: true });
      expect(options.plans.length).to.be.greaterThan(0);
    });

    it("opens again once a subscription is live", async () => {
      const id = await lawyer({ planTrialEndsAt: daysFrom(new Date(), -1) });
      await subscribe(id);
      expect(await errorOf(AccountLimitsSvc.assertCanCreateCase(id))).to.equal(undefined);
      expect(await errorOf(AccountLimitsSvc.assertAccountHasBudget(id))).to.equal(undefined);
      expect(await PaymentPlanBillingSvc.options(id)).to.include({ subscribed: true, trialEnded: false });
    });
  });

  describe("telling the lawyer", () => {
    // The sweeps look at every account; keep them to this spec's, so a run never marks (or emails)
    // a real account in the local database.
    beforeEach(() => {
      const findMany = prisma.user.findMany;
      (prisma.user as any).findMany = (args: any) => findMany({ ...args, where: { ...args.where, id: { in: ids } } });
      restore.push(() => ((prisma.user as any).findMany = findMany));
    });

    it("reminds once, within 3 days of the end, linking to the plans page", async () => {
      const soon = await lawyer({ planTrialEndsAt: daysFrom(NOW, 2) });
      const notYet = await lawyer({ planTrialEndsAt: daysFrom(NOW, 5) });

      await PlanTrialSvc.remindDue(NOW);
      await PlanTrialSvc.remindDue(NOW);

      const mine = notifications.filter((n) => ([soon, notYet] as string[]).includes(n.userId));
      expect(mine.map((n) => [n.userId, n.title, n.link])).to.deep.equal([[soon, "Your free trial ends soon", "/homepage/plans"]]);
      expect(emails.filter((e) => e.subject === "Your free trial ends soon" && [soon, notYet].map(emailOf).includes(e.to)).map((e) => e.to)).to.deep.equal([emailOf(soon)]);
    });

    it("tells them once that it has ended, but never someone who subscribed", async () => {
      const ended = await lawyer({ planTrialEndsAt: daysFrom(NOW, -1) });
      const subscribed = await lawyer({ planTrialEndsAt: daysFrom(NOW, -1) });
      await subscribe(subscribed);
      const canceled = await lawyer({ planTrialEndsAt: daysFrom(NOW, -1) });
      await subscribe(canceled, "CANCELED");

      await PlanTrialSvc.announceEnded(NOW);
      await PlanTrialSvc.announceEnded(NOW);

      const mine = notifications.filter((n) => ([ended, subscribed, canceled] as string[]).includes(n.userId));
      expect(mine.map((n) => [n.userId, n.title])).to.deep.equal([[ended, "Your free trial has ended"]]);
      expect(emails.filter((e) => e.subject === "Your free trial has ended" && [ended, subscribed, canceled].map(emailOf).includes(e.to)).map((e) => e.to)).to.deep.equal([emailOf(ended)]);
    });
  });
});
