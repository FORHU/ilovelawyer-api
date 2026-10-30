import ClientRequestRepo from "../repositories/client-request.repository";
import LawyerProfileRepo from "../repositories/lawyer-profile.repository";

// Mirrors utils/client-budget.ts's ClientBudget from PR #624 (feat/client-case-budget, not yet
// merged). Defined locally so matching doesn't block on that PR; swap this for a real import from
// utils/client-budget once it lands, rather than keeping two definitions.
export interface ClientBudget {
  minMinor: number | null;
  maxMinor: number | null;
  feePreference: string | null;
}

export interface MatchCriteria {
  /** The case's areas (Case.caseAreas). */
  caseAreas: string[];
  ukJurisdiction: string | null;
}

/** Criteria for matching that isn't tied to an existing ClientRequest — the intake chat's
 * find-a-lawyer tool and the direct "browse lawyers" feature both start from raw criteria rather
 * than a request row. */
export interface CriteriaMatchInput {
  caseAreas: string[];
  ukJurisdiction: string | null;
  /** Client Budget (utils/client-budget). Null or omitted: no budget set, every lawyer scores 0. */
  budget?: ClientBudget | null;
}

export interface RankedLawyerMatch {
  lawyerId: string;
  /** How far outside the client's budget range this lawyer's fee sits, in pence. 0: within the
   * range, no budget set, or the lawyer hasn't set a fee. Never excludes — only orders the list,
   * closest first. */
  budgetFitScore: number;
}

/** How far a lawyer's fee sits outside the client's budget range, in pence. 0 when the fee is
 * inside the range (or there's no max, i.e. an open-ended "Over £X" range), when no budget was
 * given, or when the lawyer hasn't set a fee — an unset fee is never penalised for lack of data. */
export function budgetFitScoreOf(feeMinor: number | null, budget: ClientBudget | null | undefined): number {
  if (!budget || feeMinor === null) return 0;
  if (budget.minMinor !== null && feeMinor < budget.minMinor) return budget.minMinor - feeMinor;
  if (budget.maxMinor !== null && feeMinor > budget.maxMinor) return feeMinor - budget.maxMinor;
  return 0;
}

/** What matching reads from one of a lawyer's practice areas (PracticeArea). */
export interface MatchablePracticeArea {
  caseArea: string | null;
  isActive: boolean;
}

/** What matches() needs from a lawyer. Verification is checked by the repo query (VERIFIED only) —
 * everything else is checked here, so the rule itself stays testable without a database.
 * `openCount` is how many requests they're currently holding (LawyerProfileRepo.countOpenForLawyers);
 * `capacityLimit` null means unlimited. */
export interface LawyerForMatching {
  acceptingRequests: boolean;
  enabledByOrganization: boolean;
  pausedUntil: Date | null;
  capacityLimit: number | null;
  openCount: number;
  practiceAreas: MatchablePracticeArea[];
  qualifiedJurisdictions: string[];
}

/** The client case areas (Case.caseAreas) a lawyer takes: those their active practice areas map
 * to. An inactive area, or one an admin left unmapped, routes nothing. */
export function caseAreasOf(practiceAreas: MatchablePracticeArea[]): string[] {
  return [...new Set(practiceAreas.filter((a) => a.isActive && a.caseArea).map((a) => a.caseArea!))];
}

/**
 * The request matching engine (#509): which lawyers a client request is routed to. A lawyer
 * matches when they're verified, accepting requests, enabled by their organization (#518), not
 * paused, under capacity, and qualified for any one of the case's areas (through caseAreasOf) and
 * its UK jurisdiction.
 */
export default class ClientRequestMatchingSvc {
  static matches(lawyer: LawyerForMatching, criteria: MatchCriteria, now: Date = new Date()): boolean {
    if (criteria.caseAreas.length === 0 || !criteria.ukJurisdiction) return false;
    if (!lawyer.acceptingRequests) return false;
    if (!lawyer.enabledByOrganization) return false;
    if (lawyer.pausedUntil && lawyer.pausedUntil > now) return false;
    if (lawyer.capacityLimit !== null && lawyer.openCount >= lawyer.capacityLimit) return false;
    const takes = caseAreasOf(lawyer.practiceAreas);
    if (!criteria.caseAreas.some((area) => takes.includes(area))) return false;
    if (!lawyer.qualifiedJurisdictions.includes(criteria.ukJurisdiction)) return false;
    return true;
  }

  /** REQUESTED -> ROUTED, right after the request is created. Unconditional — the client sees
   * "Finding a lawyer" even with zero current matches; EXPIRED (#510) is what ends that wait. */
  static async route(requestId: string) {
    return ClientRequestRepo.route(requestId);
  }

  /** Every verified lawyer who currently matches this request, minus anyone already excluded from
   * it. For #510 (who to notify) and #511 (inbox, claim checks). */
  static async eligibleLawyerIds(requestId: string): Promise<string[]> {
    const request = await ClientRequestRepo.findForMatching(requestId);
    if (!request) return [];
    const candidates = await LawyerProfileRepo.findVerified(request.excludedLawyerIds);
    const criteria: MatchCriteria = { caseAreas: request.case.caseAreas, ukJurisdiction: request.case.ukJurisdiction };
    return candidates.filter((lawyer) => ClientRequestMatchingSvc.matches(lawyer, criteria)).map((lawyer) => lawyer.userId);
  }

  /** Every verified lawyer who matches raw criteria, with no ClientRequest needed — the intake
   * chat's find-a-lawyer tool and the direct "browse lawyers" feature both call this. Budget never
   * excludes a lawyer, only orders the list: closest to the client's range first. */
  static async matchByCriteria(input: CriteriaMatchInput): Promise<RankedLawyerMatch[]> {
    const candidates = await LawyerProfileRepo.findVerified([]);
    const criteria: MatchCriteria = { caseAreas: input.caseAreas, ukJurisdiction: input.ukJurisdiction };
    return candidates
      .filter((lawyer) => ClientRequestMatchingSvc.matches(lawyer, criteria))
      .map((lawyer) => ({ lawyerId: lawyer.userId, budgetFitScore: budgetFitScoreOf(lawyer.firstConsultationFeeMinor, input.budget) }))
      .sort((a, b) => a.budgetFitScore - b.budgetFitScore);
  }
}
