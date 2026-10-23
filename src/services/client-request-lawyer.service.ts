import type { ClientRequestStatus, QuoteType, ReleaseReason } from "@prisma/client";
import ClientRequestRepo from "../repositories/client-request.repository";
import ClientRequestClaimRepo from "../repositories/client-request-claim.repository";
import LawyerProfileRepo, { type LawyerProfileRow } from "../repositories/lawyer-profile.repository";
import OrganizationRepo from "../repositories/organization.repository";
import ClientRequestMatchingSvc from "./client-request-matching.service";
import ClientRequestBriefSvc from "./client-request-brief.service";
import OrganizationChargeSvc from "./organization-charge.service";
import OrganizationChargeRepo from "../repositories/organization-charge.repository";
import SecurityAuditSvc from "./security-audit.service";
import { emitToUser } from "../lib/socket";
import HttpError from "../utils/http-error";
import type { TenantCode } from "../types/tenant-code";
import type { ClientRequestTakenEvent, ClientRequestUpdatedEvent } from "../types/client-handoff";

/** Who's asking, from the lawyer app's resolved workspace (X-Organization-Id): their firm, or null
 * for a solo lawyer, who has no organization and is charged on their own card (docs/adr/0022). */
export interface LawyerContext {
  userId: string;
  organizationId: string | null;
  tenantCode: TenantCode;
}

type LawyerRequest = NonNullable<Awaited<ReturnType<typeof ClientRequestRepo.findForLawyer>>>;

/** A request someone holds: claimed, then quoted, confirmed and engaged on the same claim. */
const HELD: ClientRequestStatus[] = ["CLAIMED", "QUOTED", "CONFIRMED", "ENGAGED"];

const NOT_FOUND = () => new HttpError("Request not found", 404);

/** The lawyer's quote on a claim (#512), or null before they've sent one. */
function quoteOf(claim: LawyerRequest["claims"][number] | undefined) {
  if (!claim?.quotedAt) return null;
  return {
    type: claim.quoteType,
    amount: { amountMinor: claim.quoteAmountMinor, currency: claim.quoteCurrency },
    message: claim.quoteMessage,
    sentAt: claim.quotedAt,
  };
}

/** ClientRequestForLawyer in the contract, as `lawyerId` sees it. The engagement is filled by #514;
 * until then it's always empty. The per-case fee's charge shows only to the lawyer it's for. */
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
    quote: quoteOf(mine),
    perCaseFee: OrganizationChargeSvc.perCaseFee(),
    charge: chargeOf(r, lawyerId),
    engagement: null,
  };
}

function chargeOf(r: LawyerRequest, lawyerId: string) {
  const fee = r.charges.find((c) => c.lawyerId === lawyerId);
  if (!fee) return null;
  return { id: fee.id, status: fee.status, amount: { amountMinor: fee.amountMinor, currency: fee.currency }, failureReason: fee.failureReason };
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

  /**
   * The names behind the brief, for the conflict check (#512): the client and the case's other
   * parties. Only for the lawyer holding the claim, while CLAIMED (inside the 24h) or QUOTED. Every
   * read is audited, since it's the first time the lawyer learns who the client is.
   */
  static async parties(lawyer: LawyerContext, id: string) {
    const { request, claim } = await ClientRequestLawyerSvc.heldClaim(lawyer, id, ["CLAIMED", "QUOTED"]);
    const found = await ClientRequestRepo.findParties(id);
    if (!found) throw NOT_FOUND();
    const parties = [
      { name: found.client.name || found.client.username, role: "Client" },
      ...found.case.parties.map((p) => ({ name: p.name, role: p.designation })),
    ];
    await SecurityAuditSvc.record({
      action: "client_request.parties_viewed",
      actorId: lawyer.userId,
      organizationId: lawyer.organizationId,
      targetType: "case",
      targetId: request.caseId,
      caseId: request.caseId,
      payload: { requestId: id, claimId: claim.id, parties: parties.length },
    });
    return { parties };
  }

  /**
   * Gives the request back (#512): a conflict, no capacity, or out of scope. The claim ends RELEASED
   * and the request goes back in the pool without this lawyer, as a lapse does. Allowed until the
   * client answers the quote. The note stays on the claim only: it may name the conflict, so it's
   * kept out of the case's activity feed and the audit log.
   */
  static async release(lawyer: LawyerContext, id: string, input: { reason: ReleaseReason; note?: string }) {
    const { request, claim } = await ClientRequestLawyerSvc.heldClaim(lawyer, id, ["CLAIMED", "QUOTED"], { allowExpired: true });
    const now = new Date();
    const released = await ClientRequestClaimRepo.release(
      { id: claim.id, requestId: id, lawyerId: lawyer.userId },
      { reason: input.reason, note: input.note?.trim() || null },
      now,
    );
    if (!released) {
      const current = await ClientRequestRepo.findForLawyer(id);
      throw new HttpError("This request can't be released now.", 409, "INVALID_REQUEST_STATUS", { status: current?.status ?? request.status });
    }

    const payload = { requestId: id, claimId: claim.id, reason: input.reason };
    await OrganizationRepo.writeAudit({ caseId: request.caseId, actorId: lawyer.userId, action: "client_request.released", payload });
    await SecurityAuditSvc.record({
      action: "client_request.released",
      actorId: lawyer.userId,
      organizationId: lawyer.organizationId,
      targetType: "case",
      targetId: request.caseId,
      caseId: request.caseId,
      payload,
    });
    const updated: ClientRequestUpdatedEvent = { requestId: id, status: "ROUTED", updatedAt: now.toISOString() };
    emitToUser(request.clientId, "client-request:updated", updated);

    return toDto((await ClientRequestRepo.findForLawyer(id))!, lawyer.userId);
  }

  /**
   * Sends the lawyer's quote to the client (#512): CLAIMED -> QUOTED, inside the 24h hold. A fixed
   * fee needs an amount; a first consultation may be free. The fee is the lawyer's own, paid to them
   * directly: the platform's per-case fee (#513) is separate.
   */
  static async quote(lawyer: LawyerContext, id: string, input: { type: QuoteType; amount: { amountMinor: number; currency: string }; message: string }) {
    if (input.type === "FIXED_FEE" && input.amount.amountMinor <= 0) throw new HttpError("A fixed fee needs an amount.", 400);
    const { request, claim } = await ClientRequestLawyerSvc.heldClaim(lawyer, id, ["CLAIMED"]);
    const now = new Date();
    const saved = await ClientRequestClaimRepo.quote(
      { id: claim.id, requestId: id },
      { type: input.type, amountMinor: input.amount.amountMinor, currency: input.amount.currency, message: input.message.trim() },
      now,
    );
    if (!saved) {
      const current = await ClientRequestRepo.findForLawyer(id);
      if (current?.status === "CLAIMED" && claim.expiresAt <= now) throw ClientRequestLawyerSvc.claimExpired();
      throw new HttpError("This request can't be quoted now.", 409, "INVALID_REQUEST_STATUS", { status: current?.status ?? request.status });
    }

    await OrganizationRepo.writeAudit({
      caseId: request.caseId,
      actorId: lawyer.userId,
      action: "client_request.quoted",
      payload: { requestId: id, claimId: claim.id, type: input.type, amountMinor: input.amount.amountMinor },
    });
    const updated: ClientRequestUpdatedEvent = { requestId: id, status: "QUOTED", updatedAt: now.toISOString() };
    emitToUser(request.clientId, "client-request:updated", updated);

    return toDto((await ClientRequestRepo.findForLawyer(id))!, lawyer.userId);
  }

  /**
   * Retries the per-case fee once the card has been updated (#513). Only while CONFIRMED with a failed
   * charge, by the lawyer holding it. Never charges twice: a fee that went through engages the request
   * and isn't taken again, and two retries at once can't both run. 402 CHARGE_FAILED when it fails again.
   */
  static async retryCharge(lawyer: LawyerContext, id: string) {
    await ClientRequestLawyerSvc.heldClaim(lawyer, id, ["CONFIRMED"]);
    const fee = await OrganizationChargeRepo.findFeeForRequest(id);
    if (!fee || fee.status !== "FAILED") {
      const status = fee?.status === "PENDING" ? "being charged already" : "not waiting on a retry";
      throw new HttpError(`The introduction fee is ${status}.`, 409, "INVALID_REQUEST_STATUS", { status: "CONFIRMED", chargeStatus: fee?.status ?? null });
    }
    const outcome = await OrganizationChargeSvc.attempt(fee.id);
    if (outcome === null) throw new HttpError("The introduction fee is being charged already.", 409, "INVALID_REQUEST_STATUS", { status: "CONFIRMED" });
    if (outcome === "FAILED") {
      const after = await OrganizationChargeRepo.findById(fee.id);
      throw new HttpError(after?.failureReason ?? "The card was declined.", 402, "CHARGE_FAILED");
    }
    return toDto((await ClientRequestRepo.findForLawyer(id))!, lawyer.userId);
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

  /**
   * The lawyer's open claim on the request, while it's in one of `statuses`. 404 when they've never
   * held it (so it can't be probed), 409 INVALID_REQUEST_STATUS when their claim ended or the request
   * has moved on, 409 CLAIM_EXPIRED when a CLAIMED hold's 24h is over but the sweep hasn't lapsed it
   * yet. A QUOTED hold doesn't expire: it waits for the client.
   */
  private static async heldClaim(lawyer: LawyerContext, id: string, statuses: ClientRequestStatus[], opts: { allowExpired?: boolean } = {}) {
    await ClientRequestLawyerSvc.assertVerifiedLawyer(lawyer);
    const request = await ClientRequestRepo.findForLawyer(id);
    if (!request || !request.claims.some((c) => c.lawyerId === lawyer.userId)) throw NOT_FOUND();
    const claim = request.claims.find((c) => c.lawyerId === lawyer.userId && c.outcome === null);
    if (!claim || !statuses.includes(request.status)) {
      throw new HttpError("You no longer hold this request.", 409, "INVALID_REQUEST_STATUS", { status: request.status });
    }
    if (!opts.allowExpired && request.status === "CLAIMED" && claim.expiresAt <= new Date()) throw ClientRequestLawyerSvc.claimExpired();
    return { request, claim };
  }

  private static claimExpired() {
    return new HttpError("Your 24-hour hold on this request has ended.", 409, "CLAIM_EXPIRED");
  }

  /** Whether the request is one this lawyer is matched to (whatever state it's in now), or one
   * they've held. */
  private static isFor(r: LawyerRequest, lawyerId: string, profile: LawyerProfileRow) {
    if (r.claims.some((c) => c.lawyerId === lawyerId)) return true;
    return !r.excludedLawyerIds.includes(lawyerId) && ClientRequestMatchingSvc.matches(profile, criteriaOf(r));
  }

  /** Client requests are UK only, for lawyers whose registration has been verified (#506). */
  private static async assertVerifiedLawyer(lawyer: LawyerContext): Promise<LawyerProfileRow> {
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
