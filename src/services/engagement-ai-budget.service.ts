import { ENGAGEMENT_AI_BUDGET_GBP_PER_USD, ENGAGEMENT_AI_BUDGET_INCLUDED_USD } from "../config";
import ClientRequestRepo from "../repositories/client-request.repository";
import LlmUsageRepo from "../repositories/llm-usage.repository";
import OrganizationChargeRepo from "../repositories/organization-charge.repository";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { emitToUser } from "../lib/socket";
import { AI_BUDGET_WARNING_PERCENT, CLIENT_HANDOFF_SOCKET_EVENTS, type AiBudgetState, type EngagementAiBudgetEvent, type Money } from "../types/client-handoff";

export interface AiBudgetDto {
  included: Money;
  toppedUp: Money;
  used: Money;
  remaining: Money;
  percentUsed: number;
  state: AiBudgetState;
}

/** The case an engagement's AI spend is metered on: the lawyer's own seeded Case (the engaged
 * claim's `lawyerCaseId`), or, for an engagement from before auto-seeding, the workspace copy the
 * lawyer made through the now-retired "copy to my workspace" (ClientRequest.copyCaseId). Null when
 * there's neither yet (e.g. a seed that failed) — nothing can have been spent on it either way. */
export function meteredCaseIdOf(request: { copyCaseId: string | null; claims: { outcome: string | null; lawyerCaseId: string | null }[] }): string | null {
  return request.claims.find((c) => c.outcome === "ENGAGED")?.lawyerCaseId ?? request.copyCaseId ?? null;
}

/**
 * The engagement's own AI budget (#515, ADR 0016): what comes bundled with the per-case fee, plus
 * any top-ups (#516), metered against AI use on the lawyer's own Case for the engagement
 * (LlmUsage.caseId) — the Case seeded for them at engagement (ClientRequestClaim.lawyerCaseId), or a
 * legacy workspace copy (ClientRequest.copyCaseId) on an engagement from before seeding replaced
 * "copy to my workspace". Never the client's own case. Separate from the internal per-case
 * allowance in CaseLimitsSvc, which stays hidden; this one is shown to the lawyer.
 *
 * Spend is tracked internally in USD, like every other LLM cost; the budget is shown in GBP at a
 * PLACEHOLDER rate (config.ts) until the real pricing is signed off (FORHU/ilovelawyer-app#846).
 */
export default class EngagementAiBudgetSvc {
  static gbpMinorFromUsd(usd: number): number {
    return Math.round(usd * ENGAGEMENT_AI_BUDGET_GBP_PER_USD * 100);
  }

  /** AiBudget in the contract. `meteredCaseId` (meteredCaseIdOf) is null when the lawyer has no
   * Case of their own for the engagement — nothing's been spent yet either way. */
  static async forRequest(requestId: string, meteredCaseId: string | null): Promise<AiBudgetDto> {
    const [usedUsd, toppedUpMinor] = await Promise.all([
      meteredCaseId ? LlmUsageRepo.sumCostUsd(meteredCaseId) : Promise.resolve(0),
      OrganizationChargeRepo.sumTopUpCredit(requestId),
    ]);
    return EngagementAiBudgetSvc.budgetOf(usedUsd, toppedUpMinor);
  }

  /** The engagement `caseId` is the lawyer's own metered Case for, if any: their seeded Case first
   * (findByLawyerCaseId), then a legacy workspace copy (findByCopyCaseId). */
  private static async engagementOf(caseId: string): Promise<{ id: string; caseId: string; lawyerId: string | null } | null> {
    const seeded = await ClientRequestRepo.findByLawyerCaseId(caseId);
    if (seeded) return { id: seeded.id, caseId: seeded.lawyerCaseId, lawyerId: seeded.lawyerId };
    const legacy = await ClientRequestRepo.findByCopyCaseId(caseId);
    return legacy ? { id: legacy.id, caseId: legacy.copyCaseId, lawyerId: legacy.lawyerId } : null;
  }

  /** Refuses AI work on the lawyer's own Case for an engagement once its budget is spent (403
   * ENGAGEMENT_AI_BUDGET_SPENT). A case that isn't one has nothing to check. */
  static async assertHasBudget(caseId: string): Promise<void> {
    const engagement = await EngagementAiBudgetSvc.engagementOf(caseId);
    if (!engagement) return;
    const budget = await EngagementAiBudgetSvc.forRequest(engagement.id, engagement.caseId);
    if (budget.state === "EXHAUSTED") {
      throw new HttpError("This engagement's AI budget is spent. Top up to continue.", 403, "ENGAGEMENT_AI_BUDGET_SPENT");
    }
  }

  /** After an LLM call's usage row is written (LlmUsageSvc.record), tells the engaged lawyer live
   * if it just crossed 80% or 100% of the engagement's AI budget. Fire-and-forget: never throws.
   * `justSpentUsd` is that one call's own cost, so the state just before it can be compared without
   * a second query. */
  static async checkThresholds(caseId: string, justSpentUsd: number): Promise<void> {
    try {
      const engagement = await EngagementAiBudgetSvc.engagementOf(caseId);
      if (!engagement?.lawyerId) return;
      const [afterUsd, toppedUpMinor] = await Promise.all([LlmUsageRepo.sumCostUsd(caseId), OrganizationChargeRepo.sumTopUpCredit(engagement.id)]);
      const after = EngagementAiBudgetSvc.budgetOf(afterUsd, toppedUpMinor);
      const before = EngagementAiBudgetSvc.budgetOf(Math.max(0, afterUsd - justSpentUsd), toppedUpMinor);
      if (after.state === before.state) return;
      const event: EngagementAiBudgetEvent = { requestId: engagement.id, percentUsed: after.percentUsed, state: after.state };
      emitToUser(engagement.lawyerId, CLIENT_HANDOFF_SOCKET_EVENTS.ENGAGEMENT_AI_BUDGET, event);
    } catch (err) {
      logger.warn("Engagement AI budget: threshold check failed", { err, caseId });
    }
  }

  private static budgetOf(usedUsd: number, toppedUpMinor: number): AiBudgetDto {
    const includedMinor = EngagementAiBudgetSvc.gbpMinorFromUsd(ENGAGEMENT_AI_BUDGET_INCLUDED_USD);
    const usedMinor = EngagementAiBudgetSvc.gbpMinorFromUsd(usedUsd);
    const totalMinor = includedMinor + toppedUpMinor;
    const remainingMinor = Math.max(0, totalMinor - usedMinor);
    const percentUsed = totalMinor > 0 ? Math.min(100, Math.round((usedMinor / totalMinor) * 100)) : 100;
    const state: AiBudgetState = percentUsed >= 100 ? "EXHAUSTED" : percentUsed >= AI_BUDGET_WARNING_PERCENT ? "WARNING" : "OK";
    return {
      included: { amountMinor: includedMinor, currency: "GBP" },
      toppedUp: { amountMinor: toppedUpMinor, currency: "GBP" },
      used: { amountMinor: usedMinor, currency: "GBP" },
      remaining: { amountMinor: remainingMinor, currency: "GBP" },
      percentUsed,
      state,
    };
  }
}
