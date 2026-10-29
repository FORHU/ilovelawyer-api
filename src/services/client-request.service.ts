import type { ClientRequestStatus } from "@prisma/client";
import ClientRequestRepo, { type ClientRequestForClient } from "../repositories/client-request.repository";
import { toPracticeAreaRefs } from "../repositories/practice-area.repository";
import ClientCaseRepo from "../repositories/client-case.repository";
import ClientRequestBriefSvc from "./client-request-brief.service";
import ClientRequestMatchingSvc from "./client-request-matching.service";
import OrganizationChargeSvc from "./organization-charge.service";
import ClientPricingSvc from "./client-pricing.service";
import EngagementAccessSvc from "./engagement-access.service";
import NotificationSvc from "./notification.service";
import SecurityAuditSvc from "./security-audit.service";
import ClientRequestClaimRepo from "../repositories/client-request-claim.repository";
import OrganizationChargeRepo from "../repositories/organization-charge.repository";
import OrganizationRepo from "../repositories/organization.repository";
import logger from "../utils/logger";
import HttpError from "../utils/http-error";
import { getStableProxyFileUrl } from "../utils/s3";
import { emitToUser } from "../lib/socket";
import type { ClientWorkspace } from "./client-case.service";
import type { ClientRequestTakenEvent, ClientRequestUpdatedEvent } from "../types/client-handoff";
import {
  CLIENT_REQUEST_CONSENT_TEXT,
  CLIENT_REQUEST_CONSENT_VERSION,
  CLIENT_REQUEST_REFERRAL_DISCLOSURE,
} from "../constants/client-request.constants";

/** Why the client can't ask for a lawyer on a case (CLIENT_HANDOFF_ERROR_CODES). */
type IneligibleReason = "NOT_UK_CASE" | "PERSONAL_INJURY_EXCLUDED" | "REQUEST_ALREADY_OPEN";

const REFUSALS: Record<IneligibleReason, { status: number; message: string }> = {
  NOT_UK_CASE: { status: 422, message: "Lawyers are only available for cases in the UK for now." },
  PERSONAL_INJURY_EXCLUDED: { status: 422, message: "We can't connect personal injury cases with a lawyer yet." },
  REQUEST_ALREADY_OPEN: { status: 409, message: "You've already asked for a lawyer on this case." },
};

/** A client can withdraw until they've confirmed a lawyer. */
const WITHDRAWABLE: ClientRequestStatus[] = ["REQUESTED", "ROUTED", "CLAIMED", "QUOTED"];

export interface NewClientRequest {
  caseId: string;
  note?: string;
  consentVersion: string;
  consentAccepted: boolean;
}

/** The lawyer as the client sees them once they've quoted (LawyerPublicProfile in the contract):
 * their public profile, never their organization's members or anything from the lawyer app. */
function lawyerDto(claim: ClientRequestForClient["claims"][number]) {
  const profile = claim.lawyer.clientRequestProfile;
  return {
    id: claim.lawyer.id,
    name: claim.lawyer.name ?? "",
    avatarUrl: claim.lawyer.avatar?.s3Key ? getStableProxyFileUrl(claim.lawyer.avatar.s3Key) : null,
    // A solo lawyer has no organization, so no firm (nor did a client-era personal workspace).
    firmName: claim.organization && !claim.organization.isPersonal ? claim.organization.name : null,
    regulator: profile?.ukRegistration?.regulator ?? null,
    registrationNumber: profile?.ukRegistration?.registrationNumber ?? null,
    // By name: the list is the lawyer's site's, which admins edit (PracticeArea).
    practiceAreas: profile ? toPracticeAreaRefs(profile.practiceAreas).map((a) => a.name) : [],
    qualifiedJurisdictions: profile?.ukRegistration?.qualifiedJurisdictions ?? [],
    languages: profile?.languages ?? [],
    bio: profile?.bio ?? "",
    firstConsultationFee: profile?.firstConsultationFeeMinor == null ? null : { amountMinor: profile.firstConsultationFeeMinor, currency: "GBP" },
    verifiedAt: profile?.verifiedAt ?? null,
  };
}

type ClaimForClient = ClientRequestForClient["claims"][number];

function quoteDto(claim: ClaimForClient) {
  if (!claim.quotedAt) return null;
  return {
    type: claim.quoteType,
    amount: { amountMinor: claim.quoteAmountMinor, currency: claim.quoteCurrency },
    message: claim.quoteMessage,
    sentAt: claim.quotedAt,
  };
}

/**
 * The request's status as the client sees it. Several lawyers (phase 5): the request stays ROUTED
 * until the client picks a quote, so the client sees QUOTED once any lawyer on it has quoted, and
 * CLAIMED once any has joined, as when one lawyer held a request.
 */
function statusForClient(r: ClientRequestForClient): ClientRequestStatus {
  if (r.status !== "ROUTED") return r.status;
  const open = r.claims.filter((c) => c.outcome === null);
  return open.some((c) => c.quotedAt) ? "QUOTED" : open.length ? "CLAIMED" : "ROUTED";
}

/** The lawyer the client hired, or, until they pick, the only quote: the one `lawyer`/`quote`
 * show, for an app that shows one. */
function oneLawyer(r: ClientRequestForClient): ClaimForClient | null {
  const engaged = r.claims.find((c) => c.outcome === "ENGAGED");
  if (engaged) return engaged;
  const open = r.claims.filter((c) => c.outcome === null);
  if (r.status === "CONFIRMED") return open[0] ?? null;
  const quoted = open.filter((c) => c.quotedAt);
  return quoted.length === 1 ? quoted[0]! : null;
}

/** LawyerRequestForClient in the contract. Several lawyers (phase 5): `lawyers` is everyone on the
 * request now, oldest first, each with their quote once sent (`claimId` is what confirm and decline
 * take); `pickByAt` is when it expires without a pick. `lawyer`/`quote` stay for one lawyer (the one
 * hired, or the only quote). The referral disclosure is what the client acknowledges to confirm
 * (#512). */
function toDto(r: ClientRequestForClient) {
  const one = oneLawyer(r);
  const lawyers = r.claims.map((c) => ({ claimId: c.id, joinedAt: c.claimedAt, lawyer: lawyerDto(c), quote: quoteDto(c) }));
  return {
    id: r.id,
    caseId: r.caseId,
    status: statusForClient(r),
    note: r.note,
    consentVersion: r.consentVersion,
    consentAcceptedAt: r.consentAcceptedAt,
    createdAt: r.createdAt,
    lawyers,
    pickByAt: r.status === "ROUTED" ? r.pickByAt : null,
    lawyer: one ? lawyerDto(one) : null,
    quote: one ? quoteDto(one) : null,
    referralDisclosure: lawyers.some((l) => l.quote) ? CLIENT_REQUEST_REFERRAL_DISCLOSURE : null,
    engagedAt: r.engagedAt,
    closedAt: r.closedAt,
    closedBy: r.closedBy,
    feedback: r.feedback ? { rating: r.feedback.rating, comment: r.feedback.comment, createdAt: r.feedback.createdAt } : null,
  };
}

/**
 * A client asking for a lawyer on one of their own cases (#507): only on a UK case that isn't
 * personal injury, one open request per case, with the consent text they agreed to recorded. Making
 * one starts its anonymised brief (#508) and routes it to every matching lawyer (#509); claiming
 * it is a later issue (#511).
 */
export default class ClientRequestSvc {
  static consent() {
    return { version: CLIENT_REQUEST_CONSENT_VERSION, consentText: CLIENT_REQUEST_CONSENT_TEXT, referralDisclosure: CLIENT_REQUEST_REFERRAL_DISCLOSURE };
  }

  /** Whether the app should offer "Get a lawyer" on this case, and if not, why. */
  static async eligibility(workspace: ClientWorkspace, caseId: string): Promise<{ eligible: boolean; reason: IneligibleReason | null; openRequestId: string | null }> {
    const row = await ClientCaseRepo.findById(caseId, workspace.id);
    if (!row) throw new HttpError("Case not found", 404);
    const no = (reason: IneligibleReason, openRequestId: string | null = null) => ({ eligible: false, reason, openRequestId });

    if (!row.ukJurisdiction) return no("NOT_UK_CASE");
    // Personal injury is spotted by the lawyer readiness check (Jev), which reads the chat.
    if ((row.lawyerReadiness as { blockedBy?: string } | null)?.blockedBy === "PERSONAL_INJURY") return no("PERSONAL_INJURY_EXCLUDED");
    const open = await ClientRequestRepo.findOpenForCase(caseId);
    if (open) return no("REQUEST_ALREADY_OPEN", open.id);
    return { eligible: true, reason: null, openRequestId: null };
  }

  static async create(workspace: ClientWorkspace, clientId: string, input: NewClientRequest) {
    if (!input.consentAccepted) throw new HttpError("Agree to the consent to ask for a lawyer.", 400, "CONSENT_REQUIRED");
    if (input.consentVersion !== CLIENT_REQUEST_CONSENT_VERSION) {
      throw new HttpError("The consent text has changed. Read it again before sending.", 409, "CONSENT_VERSION_STALE", { version: CLIENT_REQUEST_CONSENT_VERSION });
    }
    const check = await ClientRequestSvc.eligibility(workspace, input.caseId);
    if (check.reason) {
      const refusal = REFUSALS[check.reason];
      throw new HttpError(refusal.message, refusal.status, check.reason, check.openRequestId ? { openRequestId: check.openRequestId } : undefined);
    }
    const created = await ClientRequestRepo.create({
      caseId: input.caseId,
      clientId,
      note: input.note?.trim() ?? "",
      consentVersion: input.consentVersion,
      consentAcceptedAt: new Date(),
    });
    // The anonymised brief lawyers will see (#508). Written in the background: the AI takes a while.
    ClientRequestBriefSvc.generateInBackground(created.id);
    // Routed (#509) straight away, even with zero current matches — the client just sees "Finding
    // a lawyer" either way; EXPIRED (#510) is what ends that wait.
    const routed = await ClientRequestMatchingSvc.route(created.id);
    // Brand new, so nobody has claimed or quoted it.
    return toDto({ ...routed, claims: [], feedback: null });
  }

  static async list(clientId: string, query: { caseId?: string; page: number; limit: number }) {
    const { total, data } = await ClientRequestRepo.listForClient(clientId, query.caseId, query.page, query.limit);
    return { total, data: data.map(toDto) };
  }

  static async get(clientId: string, id: string) {
    return toDto(await ClientRequestSvc.load(clientId, id));
  }

  /** Until a lawyer is confirmed, the client can take the request back. The lawyers on it lose their
   * claims and are told; the lawyers it was routed to drop it from their inbox. */
  static async withdraw(clientId: string, id: string) {
    const request = await ClientRequestSvc.load(clientId, id);
    const now = new Date();
    const { moved, heldBy } = await ClientRequestRepo.withdraw(id, WITHDRAWABLE, now);
    if (!moved) {
      throw new HttpError("This request can't be withdrawn now.", 409, "INVALID_REQUEST_STATUS", { status: request.status });
    }
    const updated: ClientRequestUpdatedEvent = { requestId: id, status: "WITHDRAWN", updatedAt: now.toISOString() };
    for (const lawyerId of heldBy) emitToUser(lawyerId, "client-request:updated", updated);
    const taken: ClientRequestTakenEvent = { requestId: id };
    for (const lawyerId of await ClientRequestMatchingSvc.eligibleLawyerIds(id)) if (!heldBy.includes(lawyerId)) emitToUser(lawyerId, "client-request:taken", taken);
    return toDto(await ClientRequestSvc.load(clientId, id));
  }

  /**
   * The client confirms one lawyer's quote (#513; several lawyers in phase 5), having acknowledged the
   * referral disclosure: the request is CONFIRMED, that lawyer's organization is charged the per-case
   * fee straight away, and the other lawyers on it are told the client chose someone else. `claimId`
   * names the quote; it can be left out when there's only one. When the fee goes through the request
   * is ENGAGED; when the card is declined it stays CONFIRMED, the firm is asked to update the card,
   * and the client waits. Confirming twice charges once.
   */
  static async confirm(clientId: string, id: string, input: { disclosureAcknowledged: boolean; claimId?: string }) {
    if (!input.disclosureAcknowledged) {
      throw new HttpError("Read and acknowledge how ilovelawyer is paid before confirming.", 400, "DISCLOSURE_NOT_ACKNOWLEDGED");
    }
    const request = await ClientRequestSvc.load(clientId, id);
    const chosen = ClientRequestSvc.quoteToAnswer(request, input.claimId, "This lawyer can't be confirmed now.");
    // The fee is the region's (set in admin, #598): the client's, which is the lawyer's too, as the
    // hand-off is UK-only.
    const fee = await OrganizationChargeSvc.perCaseFee(await ClientPricingSvc.tenantIdForClient(clientId));
    const confirmed = await OrganizationChargeRepo.confirm(id, chosen.id, fee);
    if (!confirmed) {
      const now = await ClientRequestSvc.load(clientId, id);
      throw new HttpError("This lawyer can't be confirmed now.", 409, "INVALID_REQUEST_STATUS", { status: now.status ?? request.status });
    }

    const lawyerId = confirmed.claim.lawyerId;
    await OrganizationRepo.writeAudit({ caseId: request.caseId, actorId: clientId, action: "client_request.confirmed", payload: { requestId: id, chargeId: confirmed.charge.id, lawyerId } });
    const updated: ClientRequestUpdatedEvent = { requestId: id, status: "CONFIRMED", updatedAt: new Date().toISOString() };
    emitToUser(lawyerId, "client-request:updated", updated);
    await NotificationSvc.create({
      userId: lawyerId,
      type: "CLIENT_REQUEST",
      title: "A client confirmed you",
      message: "The client accepted your quote. The introduction fee is being charged to your card on file.",
      link: `/client-requests/${id}`,
    }).catch((err) => logger.error("Client request: failed to create notification", { err, requestId: id }));
    for (const other of confirmed.notChosen) {
      emitToUser(other, "client-request:updated", updated);
      await NotificationSvc.create({
        userId: other,
        type: "CLIENT_REQUEST",
        title: "The client chose another lawyer",
        message: "The client hired another lawyer for this request. Nothing was charged to you.",
        link: "/client-requests?view=history",
      }).catch((err) => logger.error("Client request: failed to create notification", { err, requestId: id }));
    }

    // Engages the request, or tells the firm the card was declined.
    await OrganizationChargeSvc.attempt(confirmed.charge.id);
    return toDto(await ClientRequestSvc.load(clientId, id));
  }

  /** The client declines one lawyer's quote (#513; several lawyers in phase 5): nothing is charged,
   * that lawyer doesn't see the request again, and their place frees up for another. `claimId` names
   * the quote; it can be left out when there's only one. The reason stays on the claim; the lawyer is
   * told it ended. */
  static async decline(clientId: string, id: string, input: { reason?: string; claimId?: string }) {
    const request = await ClientRequestSvc.load(clientId, id);
    const quoted = ClientRequestSvc.quoteToAnswer(request, input.claimId, "There's no quote to decline now.");
    const now = new Date();
    if (!(await ClientRequestClaimRepo.decline({ id: quoted.id, requestId: id, lawyerId: quoted.lawyerId }, input.reason?.trim() || null, now))) {
      const current = await ClientRequestSvc.load(clientId, id);
      throw new HttpError("There's no quote to decline now.", 409, "INVALID_REQUEST_STATUS", { status: current.status });
    }

    await OrganizationRepo.writeAudit({ caseId: request.caseId, actorId: clientId, action: "client_request.declined", payload: { requestId: id, claimId: quoted.id, lawyerId: quoted.lawyerId } });
    const updated: ClientRequestUpdatedEvent = { requestId: id, status: "ROUTED", updatedAt: now.toISOString() };
    emitToUser(quoted.lawyerId, "client-request:updated", updated);
    await NotificationSvc.create({
      userId: quoted.lawyerId,
      type: "CLIENT_REQUEST",
      title: "A client chose not to go ahead",
      message: "The client declined your quote. Nothing was charged.",
      link: "/client-requests?view=history",
    }).catch((err) => logger.error("Client request: failed to create notification", { err, requestId: id }));
    return toDto(await ClientRequestSvc.load(clientId, id));
  }

  /**
   * The client ends the engagement (#519): same effect as the lawyer closing it, except the client
   * does it from their own data. Only while ENGAGED. The lawyer's read-only access ends at once;
   * their workspace copy, if they made one, stays theirs.
   */
  static async end(clientId: string, id: string, input: { reason?: string }) {
    const request = await ClientRequestSvc.load(clientId, id);
    const engaged = request.claims[0];
    if (request.status !== "ENGAGED" || !engaged) {
      throw new HttpError("This engagement can't be ended now.", 409, "INVALID_REQUEST_STATUS", { status: request.status });
    }
    const now = new Date();
    if (!(await ClientRequestRepo.close(id, "CLIENT", now))) {
      const current = await ClientRequestSvc.load(clientId, id);
      throw new HttpError("This engagement can't be ended now.", 409, "INVALID_REQUEST_STATUS", { status: current.status });
    }

    await EngagementAccessSvc.revoke({ requestId: id, caseId: request.caseId, lawyerId: engaged.lawyerId });
    const payload = { requestId: id, closedBy: "CLIENT", reason: input.reason?.trim() || null };
    await OrganizationRepo.writeAudit({ caseId: request.caseId, actorId: clientId, action: "client_request.closed", payload });
    await SecurityAuditSvc.record({
      action: "client_request.closed",
      actorId: clientId,
      organizationId: engaged.organizationId,
      targetType: "case",
      targetId: request.caseId,
      caseId: request.caseId,
      payload,
    });
    const updated: ClientRequestUpdatedEvent = { requestId: id, status: "CLOSED", updatedAt: now.toISOString() };
    emitToUser(engaged.lawyerId, "client-request:updated", updated);
    await NotificationSvc.create({
      userId: engaged.lawyerId,
      type: "CLIENT_REQUEST",
      title: "The client ended the engagement",
      message: input.reason?.trim() || "The client ended the engagement. Your workspace copy, if you made one, is still yours.",
      link: "/client-requests?view=history",
    }).catch((err) => logger.error("Client request: failed to create notification", { err, requestId: id }));

    return toDto(await ClientRequestSvc.load(clientId, id));
  }

  /** The client's rating of the lawyer (#519), once CLOSED, once. */
  static async feedback(clientId: string, id: string, input: { rating: number; comment?: string }) {
    const request = await ClientRequestSvc.load(clientId, id);
    if (request.status !== "CLOSED") {
      throw new HttpError("Feedback can be given once the engagement has closed.", 409, "INVALID_REQUEST_STATUS", { status: request.status });
    }
    const created = await ClientRequestRepo.createFeedback(id, input.rating, input.comment?.trim() || null);
    if (!created) throw new HttpError("Feedback has already been given for this engagement.", 409, "INVALID_REQUEST_STATUS", { status: "CLOSED" });
    return { rating: created.rating, comment: created.comment, createdAt: created.createdAt };
  }

  /**
   * The open quote the client is answering: `claimId`'s, or the only one when it's left out. 409 when
   * the request isn't waiting on a pick or that quote isn't open; 400 QUOTE_REQUIRED when several are
   * and none was named.
   */
  private static quoteToAnswer(request: ClientRequestForClient, claimId: string | undefined, notNow: string): ClaimForClient {
    const quoted = request.claims.filter((c) => c.outcome === null && c.quotedAt);
    const status = statusForClient(request);
    if (request.status !== "ROUTED" || quoted.length === 0) throw new HttpError(notNow, 409, "INVALID_REQUEST_STATUS", { status });
    if (!claimId && quoted.length > 1) throw new HttpError("Choose which lawyer's quote this is for.", 400, "QUOTE_REQUIRED");
    const claim = claimId ? quoted.find((c) => c.id === claimId) : quoted[0];
    if (!claim) throw new HttpError(notNow, 409, "INVALID_REQUEST_STATUS", { status });
    return claim;
  }

  private static async load(clientId: string, id: string) {
    const request = await ClientRequestRepo.findForClient(id, clientId);
    if (!request) throw new HttpError("Request not found", 404);
    return request;
  }
}
