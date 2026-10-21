import type { ClientRequestStatus, LawyerClientProfile } from "@prisma/client";
import ClientRequestRepo from "../repositories/client-request.repository";
import ClientRequestClaimRepo from "../repositories/client-request-claim.repository";
import LawyerProfileRepo from "../repositories/lawyer-profile.repository";
import OrganizationRepo from "../repositories/organization.repository";
import ClientRequestMatchingSvc from "./client-request-matching.service";
import ClientRequestBriefSvc from "./client-request-brief.service";
import SecurityAuditSvc from "./security-audit.service";
import { emitToUser } from "../lib/socket";
import HttpError from "../utils/http-error";
import type { TenantCode } from "../types/tenant-code";
import type { ClientRequestTakenEvent, ClientRequestUpdatedEvent } from "../types/client-handoff";

/** Who's asking, from the lawyer app's resolved organization (X-Organization-Id). */
export interface LawyerContext {
  userId: string;
  organizationId: string;
  tenantCode: TenantCode;
}

type LawyerRequest = NonNullable<Awaited<ReturnType<typeof ClientRequestRepo.findForLawyer>>>;

/** A request someone holds: claimed, then quoted, confirmed and engaged on the same claim. */
const HELD: ClientRequestStatus[] = ["CLAIMED", "QUOTED", "CONFIRMED", "ENGAGED"];

const NOT_FOUND = () => new HttpError("Request not found", 404);

/** ClientRequestForLawyer in the contract, as `lawyerId` sees it. The quote, fee, charge and
 * engagement are filled by later issues (#512 onwards); until then they're always empty. */
function toDto(r: LawyerRequest, lawyerId: string, brief: unknown = r.brief) {
  const mine = r.claims.find((c) => c.lawyerId === lawyerId);
  return {
    id: r.id,
    status: r.status,
    brief,
    routedAt: r.routedAt,
    routingExpiresAt: r.status === "ROUTED" ? r.routingExpiresAt : null,
    claim: mine
      ? { byMe: true, lawyer: { id: mine.lawyer.id, name: mine.lawyer.name ?? "" }, claimedAt: mine.claimedAt, claimExpiresAt: mine.expiresAt }
      : null,
    quote: null,
    perCaseFee: null,
    charge: null,
    engagement: null,
  };
}

function criteriaOf(r: LawyerRequest) {
  return { practiceArea: r.case.practiceArea, ukJurisdiction: r.case.ukJurisdiction };
}

/**
 * The lawyer app's side of client requests (#511): the inbox, accepting (claiming) a request for
 * 24h, and passing on one. Who a request is for is ClientRequestMatchingSvc's rule; the first claim
 * wins in ClientRequestClaimRepo.claim. A claim that runs out lapses in ClientRequestSweepQueue.
 */
export default class ClientRequestLawyerSvc {
  /** inbox: routed to them, unclaimed, not passed. mine: ones they hold or are engaged on.
   * history: ones they held that ended. */
  static async list(lawyer: LawyerContext, query: { view: "inbox" | "mine" | "history"; page: number; limit: number }) {
    const profile = await ClientRequestLawyerSvc.assertVerifiedLawyer(lawyer);
    if (query.view !== "inbox") {
      const { total, data } = await ClientRequestRepo.listHeldBy(lawyer.userId, query.view, query.page, query.limit);
      return { total, data: data.map((r) => toDto(r, lawyer.userId)) };
    }

    // The database narrows to the lawyer's practice areas and jurisdictions; matches() is still the
    // rule. Paged here, after it: the routed, unclaimed pool is small, and the lawyer-level checks
    // (accepting, paused, enabled) would otherwise make the database's total wrong.
    const now = new Date();
    const candidates = await ClientRequestRepo.listRoutedFor(lawyer.userId, { practiceAreas: profile.practiceAreas, jurisdictions: profile.qualifiedJurisdictions }, now);
    const inbox = candidates.filter((r) => ClientRequestMatchingSvc.matches(profile, criteriaOf(r), now));
    const start = (query.page - 1) * query.limit;
    return { total: inbox.length, data: inbox.slice(start, start + query.limit).map((r) => toDto(r, lawyer.userId)) };
  }

  /** One request: routed to them and still open to a claim, or one they've held. */
  static async get(lawyer: LawyerContext, id: string) {
    const profile = await ClientRequestLawyerSvc.assertVerifiedLawyer(lawyer);
    const request = await ClientRequestRepo.findForLawyer(id);
    if (!request) throw NOT_FOUND();
    const held = request.claims.some((c) => c.lawyerId === lawyer.userId);
    const open = request.status === "ROUTED" && !!request.routingExpiresAt && request.routingExpiresAt > new Date();
    if (!held && !(open && ClientRequestLawyerSvc.isFor(request, lawyer.userId, profile))) throw NOT_FOUND();
    // Rewritten first if the case changed and nobody has claimed it yet (#508).
    return toDto(request, lawyer.userId, await ClientRequestBriefSvc.current(id));
  }

  /** Accept: the first claim wins a 24h hold, and every other matching lawyer is told it's gone. */
  static async claim(lawyer: LawyerContext, id: string) {
    const profile = await ClientRequestLawyerSvc.assertVerifiedLawyer(lawyer);
    const request = await ClientRequestRepo.findForLawyer(id);
    // Whatever its status, so a lawyer who lost the race hears why rather than "not found".
    if (!request || !ClientRequestLawyerSvc.isFor(request, lawyer.userId, profile)) throw NOT_FOUND();

    const claim = await ClientRequestClaimRepo.claim(id, lawyer.userId, lawyer.organizationId);
    if (!claim) {
      const now = (await ClientRequestRepo.findForLawyer(id)) ?? request;
      if (HELD.includes(now.status) && now.claims.some((c) => c.outcome === null && c.lawyerId !== lawyer.userId)) {
        throw new HttpError("Another lawyer accepted this request first.", 409, "REQUEST_ALREADY_CLAIMED");
      }
      throw new HttpError("This request can't be accepted now.", 409, "INVALID_REQUEST_STATUS", { status: now.status });
    }

    await OrganizationRepo.writeAudit({ caseId: request.caseId, actorId: lawyer.userId, action: "client_request.claimed", payload: { requestId: id, claimId: claim.id } });
    await SecurityAuditSvc.record({
      action: "client_request.claimed",
      actorId: lawyer.userId,
      organizationId: lawyer.organizationId,
      targetType: "case",
      targetId: request.caseId,
      caseId: request.caseId,
      payload: { requestId: id, claimId: claim.id },
    });

    const others = (await ClientRequestMatchingSvc.eligibleLawyerIds(id)).filter((userId) => userId !== lawyer.userId);
    const taken: ClientRequestTakenEvent = { requestId: id };
    for (const userId of others) emitToUser(userId, "client-request:taken", taken);
    const updated: ClientRequestUpdatedEvent = { requestId: id, status: "CLAIMED", updatedAt: claim.claimedAt.toISOString() };
    emitToUser(request.clientId, "client-request:updated", updated);

    const after = (await ClientRequestRepo.findForLawyer(id))!;
    return toDto(after, lawyer.userId);
  }

  /** Pass: the lawyer stops seeing the request. Nothing else about it changes. A lawyer holding it
   * releases it instead (#512), which also puts it back in the pool. */
  static async pass(lawyer: LawyerContext, id: string) {
    const profile = await ClientRequestLawyerSvc.assertVerifiedLawyer(lawyer);
    const request = await ClientRequestRepo.findForLawyer(id);
    if (!request || !ClientRequestLawyerSvc.isFor(request, lawyer.userId, profile)) throw NOT_FOUND();
    if (request.claims.some((c) => c.lawyerId === lawyer.userId && c.outcome === null)) {
      throw new HttpError("You hold this request. Release it instead.", 409, "INVALID_REQUEST_STATUS", { status: request.status });
    }
    await ClientRequestRepo.exclude(id, lawyer.userId);
  }

  /** Whether the request is one this lawyer is matched to (whatever state it's in now), or one
   * they've held. */
  private static isFor(r: LawyerRequest, lawyerId: string, profile: LawyerClientProfile) {
    if (r.claims.some((c) => c.lawyerId === lawyerId)) return true;
    return !r.excludedLawyerIds.includes(lawyerId) && ClientRequestMatchingSvc.matches(profile, criteriaOf(r));
  }

  /** Client requests are UK only, for lawyers whose registration has been verified (#506). */
  private static async assertVerifiedLawyer(lawyer: LawyerContext): Promise<LawyerClientProfile> {
    const who = await LawyerProfileRepo.findLawyerTenant(lawyer.userId);
    if (!who || who.role !== "LAWYER") throw new HttpError("Client requests are for lawyer accounts", 403, "NOT_A_LAWYER");
    if (lawyer.tenantCode !== "UK") throw new HttpError("Client requests are only available on the UK site", 403, "NOT_UK_TENANT");
    const profile = await LawyerProfileRepo.find(lawyer.userId);
    if (!profile || profile.verificationStatus !== "VERIFIED") {
      throw new HttpError("You can see client requests once we've verified your registration.", 403, "LAWYER_NOT_VERIFIED");
    }
    return profile;
  }
}
