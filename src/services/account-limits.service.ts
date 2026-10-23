import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import HttpError from "../utils/http-error";
import { MAX_CASES_PER_ACCOUNT, CASE_SPEND_LIMIT_USD } from "../config";
import { emitToUser } from "../lib/socket";

type DbClient = Prisma.TransactionClient | typeof prisma;

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
      select: { role: true, tenantId: true, caseLimitNotifiedAt: true, paymentPlan: { select: { caseLimit: true } } },
    });
    if (user?.role !== "LAWYER") return;

    const limit = user.tenantId ? (user.paymentPlan?.caseLimit ?? 0) : MAX_CASES_PER_ACCOUNT;
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
    if (info.locked) {
      throw new HttpError("Your account has reached its AI usage allowance. You can still read everything. Top up to keep going.", 403, "ACCOUNT_ALLOWANCE_REACHED");
    }
  }

  /** The dollar amount left before the account locks, and whether it already has — null when the
   * account isn't allowance-limited at all (not LAWYER-owned). `remainingUsd`/`consumedPct` are
   * shown to the lawyer; the ceiling itself (`thresholdUsd`) is returned for internal callers only
   * (e.g. the top-up quote) and is never put in a user-facing response as a bare figure out of
   * context. */
  static async allowanceInfo(
    userId: string,
    db: typeof prisma = prisma,
  ): Promise<{ limited: boolean; locked: boolean; remainingUsd: number | null; consumedPct: number | null; thresholdUsd: number }> {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { role: true, extraAiAllowanceUsd: true, tenantId: true, allowancePeriodStart: true, paymentPlan: { select: { includedAllowanceUsd: true } } },
    });
    if (user?.role !== "LAWYER") return { limited: false, locked: false, remainingUsd: null, consumedPct: null, thresholdUsd: 0 };

    // A tenant-less lawyer (legacy/edge case) still honors the global off-switch: threshold 0
    // there really does mean "unlimited". A tenant-scoped lawyer with no tier (never subscribed,
    // or canceled) is NOT unlimited — included is 0, so a threshold of 0 (no tier and no top-up
    // credit left) means locked, matching the "cancellation -> read-only" product decision.
    const included = user.tenantId ? (user.paymentPlan?.includedAllowanceUsd ?? 0) : CASE_SPEND_LIMIT_USD;
    const threshold = included + user.extraAiAllowanceUsd;
    if (!threshold) {
      return user.tenantId
        ? { limited: true, locked: true, remainingUsd: 0, consumedPct: 100, thresholdUsd: 0 }
        : { limited: false, locked: false, remainingUsd: null, consumedPct: null, thresholdUsd: 0 };
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
    };
  }

  /** Staff/top-up only: adds to one account's AI allowance. `db` accepts a transaction client so a
   * caller (e.g. AccountAiTopUpRepo.settle) can apply the increment atomically with its own state
   * change. */
  static async grantExtraAllowance(userId: string, usd: number, db: DbClient = prisma) {
    return db.user.update({ where: { id: userId }, data: { extraAiAllowanceUsd: { increment: usd } }, select: { id: true, email: true, extraAiAllowanceUsd: true } });
  }
}
