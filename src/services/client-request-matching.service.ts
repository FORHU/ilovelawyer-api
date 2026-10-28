import ClientRequestRepo from "../repositories/client-request.repository";
import LawyerProfileRepo from "../repositories/lawyer-profile.repository";

export interface MatchCriteria {
  /** The case's areas (Case.caseAreas). */
  caseAreas: string[];
  ukJurisdiction: string | null;
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

  /** Puts a held request back in the pool without one lawyer, for #511 (pass/release) and #512
   * (client decline) to call once built. False if the request wasn't CLAIMED or QUOTED to begin
   * with — something else already moved it on. */
  static async reroute(requestId: string, excludeLawyerId: string): Promise<boolean> {
    return ClientRequestRepo.reroute(requestId, excludeLawyerId);
  }
}
