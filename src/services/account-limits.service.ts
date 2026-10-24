import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import HttpError from "../utils/http-error";
import { MAX_CASES_PER_ACCOUNT, CASE_SPEND_LIMIT_USD } from "../config";
import { emitToUser } from "../lib/socket";
import { LIVE_SUBSCRIPTION_STATUSES } from "../constants/plan-trial.constants";

type DbClient = Prisma.TransactionClient | typeof prisma;

export interface AllowanceInfo {
  limited: boolean;
  locked: boolean;
  remainingUsd: number | null;
  consumedPct: number | null;
  thresholdUsd: number;
  trialEnded: boolean;
  trialEndsAt: Date | null;
}

/** Two limits on a lawyer account: how many cases it may own (from the lawyer's PaymentPlan tier,
 * PaymentPlanSvc — per-tier, admin-configurable, replacing the old flat MAX_CASES_PER_ACCOUNT
 * off-switch for every tenant-scoped lawyer), and how much AI the account as a whole may use per
 * that same tier's includedAllowanceUsd, plus any self-serve top-up credit
 * (User.extraAiAllowanceUsd). Applies to LAWYER accounts only; staff and other roles are never
 * limited.
 *
 * A lawyer with no tier (User.paymentPlanId null — never subscribed, or canceled) is NOT treated
 * as unlimited: for a tenant-scoped lawyer, no tier means included allowance 0, so the account is
 * locked (read-only) exactly like hitting $0 — the same UX, no new state. Only a lawyer with no
 * tenant at all (a legacy/edge case) still falls back to the global CASE_SPEND_LIMIT_USD off-switch.
 *
 * A solo lawyer whose free trial is over (User.planTrialEndsAt, PlanTrialSvc) and who has no live
 * subscription is locked the same way, whatever is left of their allowance or top-up credit: they
 * read everything, but start no AI work and create no case until they subscribe (PLAN_TRIAL_ENDED).
 *
 * The ceiling itself is still never stated as a fixed number in an error. The dollar amount *left*
 * and the percentage used, however, ARE shown to the lawyer (remainingAllowanceUsd/consumedPct on
 * the account — product decision, so a lawyer can see a top-up applied and isn't "being cheated"). */
export default class AccountLimitsSvc {
  /** Throws once a lawyer already owns their tier's case limit (active or archived). 0 = unlimited.
   * A lawyer already OVER the limit (grandfathered in from a tier backfill) gets a one-time notice
   * the first time they're turned back, but keeps every case they already have — this only ever
   * blocks creating one more. */
  static async assertCanCreateCase(userId: string, db: typeof prisma = prisma) {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { role: true, tenantId: true, caseLimitNotifiedAt: true, planTrialEndsAt: true, paymentPlan: { select: { caseLimit: true } } },
    });
    if (user?.role !== "LAWYER") return;
    if (await AccountLimitsSvc.planTrialOver(userId, user.planTrialEndsAt, db)) {
      throw new HttpError("Your free trial has ended. Choose a plan to create new cases.", 403, "PLAN_TRIAL_ENDED");
    }

    // No tier (no tenant, or canceled): the global MAX_CASES_PER_ACCOUNT fallback.
    const limit = user.paymentPlan?.caseLimit ?? MAX_CASES_PER_ACCOUNT;
    if (!limit) return;

    const owned = await db.case.count({ where: { userId } });
    if (owned > limit && !user.caseLimitNotifiedAt) {
      await AccountLimitsSvc.notifyOverCaseLimit(userId, limit, owned, db);
    }
    if (owned >= limit) {
      throw new HttpError(`You can have up to ${limit} cases. Delete one to create another, or contact us if you need more.`, 403, "CASE_LIMIT_REACHED");
    }
  }

  /** One-time notice for a lawyer already over their (newly introduced or newly downgraded) tier's
   * case limit — never retroactive on their existing cases, only on creating more. Fenced by
   * User.caseLimitNotifiedAt so it fires exactly once per lawyer. */
  private static async notifyOverCaseLimit(userId: string, limit: number, owned: number, db: typeof prisma) {
    const notification = await db.notification.create({
      data: {
        userId,
        type: "SYSTEM",
        title: "Your case limit changed",
        message: `Your plan includes up to ${limit} cases, and you already have ${owned}. You can keep using every case you have — to create a new one, free one up or move to a higher plan.`,
      },
    });
    emitToUser(userId, "notification:new", notification);
    await db.user.update({ where: { id: userId }, data: { caseLimitNotifiedAt: new Date() } });
  }

  /** Throws once a lawyer's account has used its AI allowance, across every case. Spend is only
   * known after a call ends, so the request that crosses the line still finishes. */
  static async assertAccountHasBudget(userId: string, db: typeof prisma = prisma) {
    const info = await AccountLimitsSvc.allowanceInfo(userId, db);
    if (info.trialEnded) {
      throw new HttpError("Your free trial has ended. You can still read everything. Choose a plan to keep going.", 403, "PLAN_TRIAL_ENDED");
    }
    if (info.locked) {
      throw new HttpError("Your account has reached its AI usage allowance. You can still read everything. Top up to keep going.", 403, "ACCOUNT_ALLOWANCE_REACHED");
    }
  }

  /** The dollar amount left before the account locks, and whether it already has — null when the
   * account isn't allowance-limited at all (not LAWYER-owned). `trialEnded`: locked because the
   * solo lawyer's free trial is over and they don't subscribe (`trialEndsAt` is when it ends or
   * ended, null with no trial). `remainingUsd`/`consumedPct` are
   * shown to the lawyer; the ceiling itself (`thresholdUsd`) is returned for internal callers only
   * (e.g. the top-up quote) and is never put in a user-facing response as a bare figure out of
   * context. */
  static async allowanceInfo(
    userId: string,
    db: typeof prisma = prisma,
  ): Promise<AllowanceInfo> {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { role: true, extraAiAllowanceUsd: true, tenantId: true, allowancePeriodStart: true, planTrialEndsAt: true, paymentPlan: { select: { includedAllowanceUsd: true } } },
    });
    if (user?.role !== "LAWYER") return { limited: false, locked: false, remainingUsd: null, consumedPct: null, thresholdUsd: 0, trialEnded: false, trialEndsAt: null };
    const trial = { trialEnded: false, trialEndsAt: user.planTrialEndsAt ?? null };
    if (await AccountLimitsSvc.planTrialOver(userId, user.planTrialEndsAt, db)) {
      return { limited: true, locked: true, remainingUsd: 0, consumedPct: 100, thresholdUsd: 0, ...trial, trialEnded: true };
    }

    // A tenant-less lawyer (legacy/edge case) still honors the global off-switch: threshold 0
    // there really does mean "unlimited". A tenant-scoped lawyer with no tier (never subscribed,
    // or canceled) is NOT unlimited — included is 0, so a threshold of 0 (no tier and no top-up
    // credit left) means locked, matching the "cancellation -> read-only" product decision.
    const included = user.tenantId ? (user.paymentPlan?.includedAllowanceUsd ?? 0) : CASE_SPEND_LIMIT_USD;
    const threshold = included + user.extraAiAllowanceUsd;
    if (!threshold) {
      return user.tenantId
        ? { limited: true, locked: true, remainingUsd: 0, consumedPct: 100, thresholdUsd: 0, ...trial }
        : { limited: false, locked: false, remainingUsd: null, consumedPct: null, thresholdUsd: 0, ...trial };
    }

    const { _sum } = await db.llmUsage.aggregate({
      where: { userId, ...(user.allowancePeriodStart ? { createdAt: { gte: user.allowancePeriodStart } } : {}) },
      _sum: { estimatedCostUsd: true },
    });
    const spent = _sum.estimatedCostUsd ?? 0;
    return {
      limited: true,
      locked: spent >= threshold,
      remainingUsd: Math.max(0, threshold - spent),
      consumedPct: Math.min(100, Math.round((spent / threshold) * 1000) / 10),
      thresholdUsd: threshold,
      ...trial,
    };
  }

  /** Whether a lawyer can still work only by subscribing: their free trial (`planTrialEndsAt`) is
   * over and no subscription is live. Asks about subscriptions only once a trial has ended. */
  static async planTrialOver(userId: string, planTrialEndsAt: Date | null, db: typeof prisma = prisma, now: Date = new Date()): Promise<boolean> {
    if (!planTrialEndsAt || planTrialEndsAt > now) return false;
    const live = await db.paymentPlanSubscription.findFirst({ where: { userId, status: { in: LIVE_SUBSCRIPTION_STATUSES } }, select: { id: true } });
    return !live;
  }

  /** planTrialOver for a lawyer by id alone (the top-up checkout). */
  static async planTrialOverFor(userId: string, db: typeof prisma = prisma): Promise<boolean> {
    const user = await db.user.findUnique({ where: { id: userId }, select: { planTrialEndsAt: true } });
    return AccountLimitsSvc.planTrialOver(userId, user?.planTrialEndsAt ?? null, db);
  }

  /** Starts a new allowance period on `paymentPlanId` (a paid subscription's first or next billing
   * period): spend is summed from `periodStart` on. Top-up credit the lawyer paid for carries over,
   * less whatever of it the ending period used — the tier's own allowance is spent first, so it's
   * never wiped by a renewal and never granted twice. Pass a transaction client to apply it
   * atomically with the subscription's own state change. */
  static async startAllowancePeriod(userId: string, paymentPlanId: string, periodStart: Date, db: DbClient = prisma) {
    const user = await db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { extraAiAllowanceUsd: true, allowancePeriodStart: true, paymentPlan: { select: { includedAllowanceUsd: true } } },
    });
    const { _sum } = await db.llmUsage.aggregate({
      where: { userId, ...(user.allowancePeriodStart ? { createdAt: { gte: user.allowancePeriodStart } } : {}) },
      _sum: { estimatedCostUsd: true },
    });
    const included = user.paymentPlan?.includedAllowanceUsd ?? 0;
    const extra = user.extraAiAllowanceUsd;
    const carriedExtra = Math.max(0, Math.min(extra, included + extra - (_sum.estimatedCostUsd ?? 0)));
    await db.user.update({ where: { id: userId }, data: { paymentPlanId, allowancePeriodStart: periodStart, extraAiAllowanceUsd: carriedExtra } });
  }

  /** Staff/top-up only: adds to one account's AI allowance. `db` accepts a transaction client so a
   * caller (e.g. AccountAiTopUpRepo.settle) can apply the increment atomically with its own state
   * change. */
  static async grantExtraAllowance(userId: string, usd: number, db: DbClient = prisma) {
    return db.user.update({ where: { id: userId }, data: { extraAiAllowanceUsd: { increment: usd } }, select: { id: true, email: true, extraAiAllowanceUsd: true } });
  }
}
