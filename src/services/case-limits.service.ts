import prisma from "../lib/prisma";
import HttpError from "../utils/http-error";
import { MAX_CASES_PER_ACCOUNT, CASE_SPEND_LIMIT_USD } from "../config";

/** Two limits on a lawyer account: how many cases it may own, and how much AI one case may use.
 * Both are set in config (MAX_CASES_PER_ACCOUNT, CASE_SPEND_LIMIT_USD) and apply to LAWYER accounts
 * only; staff and other roles are never limited. Neither removes anything already there.
 *
 * The AI allowance is internal. No message, error detail or response ever states the amount, the
 * amount used or the amount left; a lawyer who reaches it is told to contact us, and staff add to
 * that one case with grantExtraAllowance (scripts/grant-case-allowance.ts). */
export default class CaseLimitsSvc {
  /** Throws once a lawyer already owns their allowance of cases (active or archived). Deleting a
   * case frees a place; a lawyer already over the limit keeps their cases and just cannot add more. */
  static async assertCanCreateCase(userId: string, db: typeof prisma = prisma, limit = MAX_CASES_PER_ACCOUNT) {
    if (!limit) return;
    const user = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (user?.role !== "LAWYER") return;
    const owned = await db.case.count({ where: { userId } });
    if (owned >= limit) {
      throw new HttpError(`You can have up to ${limit} cases. Delete one to create another, or contact us if you need more.`, 403, "CASE_LIMIT_REACHED");
    }
  }

  /** Throws once a lawyer's case has used its AI allowance (the base amount plus anything staff added
   * to this case). Spend is only known after a call ends, so the request that crosses the line still
   * finishes. A case with no owner, or owned by anyone but a lawyer, has no allowance. */
  static async assertCaseHasBudget(caseId: string, db: typeof prisma = prisma, limit = CASE_SPEND_LIMIT_USD) {
    if (!limit) return;
    const row = await db.case.findUnique({ where: { id: caseId }, select: { extraAiAllowanceUsd: true, user: { select: { role: true } } } });
    if (row?.user?.role !== "LAWYER") return;
    const { _sum } = await db.llmUsage.aggregate({ where: { caseId }, _sum: { estimatedCostUsd: true } });
    if ((_sum.estimatedCostUsd ?? 0) >= limit + row.extraAiAllowanceUsd) {
      throw new HttpError("This case has reached its AI usage allowance. You can still read everything in it. Contact us to request more.", 403, "CASE_ALLOWANCE_REACHED");
    }
  }

  /** Staff only: adds to one case's AI allowance. */
  static async grantExtraAllowance(caseId: string, usd: number, db: typeof prisma = prisma) {
    return db.case.update({ where: { id: caseId }, data: { extraAiAllowanceUsd: { increment: usd } }, select: { id: true, caseName: true, extraAiAllowanceUsd: true } });
  }
}
