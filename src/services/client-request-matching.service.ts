import type { OrganizationMemberStatus, OrganizationStatus, PackageSku } from "@prisma/client";
import ClientRequestRepo from "../repositories/client-request.repository";
import LawyerProfileRepo from "../repositories/lawyer-profile.repository";

/** The lawyer's one membership (OrganizationMember.userId is unique), as matching reads it. */
export interface MembershipForMatching {
  status: OrganizationMemberStatus;
  organization: { id: string; isPersonal: boolean; status: OrganizationStatus; packageSku: PackageSku };
}

/** iFindLawyer (#558): whether a lawyer takes a request on their own or for their firm. A personal
 * workspace or a firm invite not yet accepted is still SOLO. `packageSku` is for #557 (premium firms
 * have no case cap). */
export type Affiliation =
  | { kind: "SOLO" }
  | { kind: "ORGANIZATION"; organizationId: string; packageSku: PackageSku; organizationStatus: OrganizationStatus };

/** Whether lawyers in a firm take client requests at all. Off unless CLIENT_REQUESTS_FOR_FIRMS=true:
 * for now only solo practitioners get them, and a firm member is left out of matching (no inbox,
 * no notice, no new claim; one they already hold carries on). */
export function clientRequestsForFirms(): boolean {
  return process.env.CLIENT_REQUESTS_FOR_FIRMS === "true";
}

export interface MatchCriteria {
  practiceArea: string | null;
  ukJurisdiction: string | null;
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
  practiceAreas: string[];
  qualifiedJurisdictions: string[];
  membership: MembershipForMatching | null;
}

/**
 * The request matching engine (#509): which lawyers a client request is routed to. A lawyer
 * matches when they're verified, accepting requests, enabled by their organization (#518), solo or
 * in a firm that takes client requests and isn't being deleted (#558), not paused, under capacity,
 * and qualified for the case's practice area and UK jurisdiction.
 */
export default class ClientRequestMatchingSvc {
  static matches(lawyer: LawyerForMatching, criteria: MatchCriteria, now: Date = new Date()): boolean {
    if (!criteria.practiceArea || !criteria.ukJurisdiction) return false;
    if (!lawyer.acceptingRequests) return false;
    if (!lawyer.enabledByOrganization) return false;
    const affiliation = ClientRequestMatchingSvc.affiliationOf(lawyer.membership);
    if (affiliation.kind === "ORGANIZATION" && (!clientRequestsForFirms() || affiliation.organizationStatus !== "ACTIVE")) return false;
    if (lawyer.pausedUntil && lawyer.pausedUntil > now) return false;
    if (lawyer.capacityLimit !== null && lawyer.openCount >= lawyer.capacityLimit) return false;
    if (!lawyer.practiceAreas.includes(criteria.practiceArea)) return false;
    if (!lawyer.qualifiedJurisdictions.includes(criteria.ukJurisdiction)) return false;
    return true;
  }

  static affiliationOf(membership: MembershipForMatching | null): Affiliation {
    if (!membership || membership.status !== "ACCEPTED" || membership.organization.isPersonal) return { kind: "SOLO" };
    const { id, packageSku, status } = membership.organization;
    return { kind: "ORGANIZATION", organizationId: id, packageSku, organizationStatus: status };
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
