import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import HttpError from "../utils/http-error";
import { MAX_CASES_PER_ACCOUNT, CASE_SPEND_LIMIT_USD } from "../config";
import AccountTopUpPricingSvc from "./account-topup-pricing.service";

type DbClient = Prisma.TransactionClient | typeof prisma;

/** Two limits on a lawyer account: how many cases it may own (MAX_CASES_PER_ACCOUNT — off by
 * default; cases are no longer billed individually), and how much AI the account as a whole may
 * use per the admin's subscription plan for its tenant (AccountTopUpPricingSvc.plan's
 * includedAllowanceUsd, falling back to CASE_SPEND_LIMIT_USD for a tenant with no plan row yet),
 * plus any self-serve top-up credit (User.extraAiAllowanceUsd). Applies to LAWYER accounts only;
 * staff and other roles are never limited.
 *
 * The ceiling itself is still never stated as a fixed number in an error. The dollar amount *left*
 * and the percentage used, however, ARE shown to the lawyer (remainingAllowanceUsd/consumedPct on
 * the account — product decision, so a lawyer can see a top-up applied and isn't "being cheated"). */
export default class AccountLimitsSvc {
  /** Throws once a lawyer already owns their allowance of cases (active or archived). Off by
   * default (MAX_CASES_PER_ACCOUNT=0) now that cases aren't billed individually. */
  static async assertCanCreateCase(userId: string, db: typeof prisma = prisma, limit = MAX_CASES_PER_ACCOUNT) {
    if (!limit) return;
    const user = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (user?.role !== "LAWYER") return;
    const owned = await db.case.count({ where: { userId } });
    if (owned >= limit) {
      throw new HttpError(`You can have up to ${limit} cases. Delete one to create another, or contact us if you need more.`, 403, "CASE_LIMIT_REACHED");
    }
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
    const user = await db.user.findUnique({ where: { id: userId }, select: { role: true, extraAiAllowanceUsd: true, tenantId: true } });
    if (user?.role !== "LAWYER") return { limited: false, locked: false, remainingUsd: null, consumedPct: null, thresholdUsd: 0 };

    const included = user.tenantId ? (await AccountTopUpPricingSvc.plan(user.tenantId)).includedAllowanceUsd : CASE_SPEND_LIMIT_USD;
    const threshold = included + user.extraAiAllowanceUsd;
    if (!threshold) return { limited: false, locked: false, remainingUsd: null, consumedPct: null, thresholdUsd: 0 };

    const { _sum } = await db.llmUsage.aggregate({ where: { userId }, _sum: { estimatedCostUsd: true } });
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
