import ClientRequestRepo from "../repositories/client-request.repository";
import LawyerProfileRepo from "../repositories/lawyer-profile.repository";

export interface MatchCriteria {
  practiceArea: string | null;
  ukJurisdiction: string | null;
}

/** What matches() needs from a lawyer. Verification is checked by the repo query (VERIFIED only) —
 * everything else is checked here, so the rule itself stays testable without a database. */
export interface LawyerForMatching {
  acceptingRequests: boolean;
  enabledByOrganization: boolean;
  pausedUntil: Date | null;
  practiceAreas: string[];
  qualifiedJurisdictions: string[];
}

/**
 * The request matching engine (#509): which lawyers a client request is routed to. A lawyer
 * matches when they're verified, accepting requests, enabled by their organization (#518), not
 * paused, under capacity, and qualified for the case's practice area and UK jurisdiction. Under
 * capacity is a stub (always true) until Engagements exist (#514) — same stub as
 * LawyerProfileSvc's openEngagements.
 */
export default class ClientRequestMatchingSvc {
  static matches(lawyer: LawyerForMatching, criteria: MatchCriteria, now: Date = new Date()): boolean {
    if (!criteria.practiceArea || !criteria.ukJurisdiction) return false;
    if (!lawyer.acceptingRequests) return false;
    if (!lawyer.enabledByOrganization) return false;
    if (lawyer.pausedUntil && lawyer.pausedUntil > now) return false;
    if (!lawyer.practiceAreas.includes(criteria.practiceArea)) return false;
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
    const criteria: MatchCriteria = { practiceArea: request.case.practiceArea, ukJurisdiction: request.case.ukJurisdiction };
    return candidates.filter((lawyer) => ClientRequestMatchingSvc.matches(lawyer, criteria)).map((lawyer) => lawyer.userId);
  }

  /** Puts a held request back in the pool without one lawyer, for #511 (pass/release) and #512
   * (client decline) to call once built. False if the request wasn't CLAIMED or QUOTED to begin
   * with — something else already moved it on. */
  static async reroute(requestId: string, excludeLawyerId: string): Promise<boolean> {
    return ClientRequestRepo.reroute(requestId, excludeLawyerId);
  }
}
