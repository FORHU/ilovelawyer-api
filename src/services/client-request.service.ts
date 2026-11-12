import type { ClientRequestStatus, LawyerExit, QuotationPayment, QuotationRefund } from "@prisma/client";
import ClientRequestRepo, { type ClientRequestForClient } from "../repositories/client-request.repository";
import { toPracticeAreaRefs } from "../repositories/practice-area.repository";
import ClientCaseRepo from "../repositories/client-case.repository";
import ClientRequestBriefSvc from "./client-request-brief.service";
import ClientRequestMatchingSvc from "./client-request-matching.service";
import EngagementAccessSvc from "./engagement-access.service";
import QuotationPaymentSvc from "./quotation-payment.service";
import EngagementCompletionSvc, { completionDto } from "./engagement-completion.service";
import QuotationRepo from "../repositories/quotation.repository";
import QuotationPaymentRepo from "../repositories/quotation-payment.repository";
import LawyerExitRepo from "../repositories/lawyer-exit.repository";
import WalletRepo from "../repositories/wallet.repository";
import PayoutSettingsSvc from "./payout-settings.service";
import ClientPricingSvc from "./client-pricing.service";
import WalletSvc from "./wallet.service";
import { quotationDto } from "./quotation.dto";
import NotificationSvc from "./notification.service";
import SecurityAuditSvc from "./security-audit.service";
import ClientRequestClaimRepo from "../repositories/client-request-claim.repository";
import OrganizationRepo from "../repositories/organization.repository";
import logger from "../utils/logger";
import HttpError from "../utils/http-error";
import { shownStatus } from "../utils/client-request-status";
import { getStableProxyFileUrl } from "../utils/s3";
import { emitToUser } from "../lib/socket";
import type { ClientWorkspace } from "./client-case.service";
import type { ClientRefundSummary, ClientRequestTakenEvent, ClientRequestUpdatedEvent } from "../types/client-handoff";
import LawyerProfileRepo from "../repositories/lawyer-profile.repository";
import {
  CLIENT_REQUEST_CONSENT_TEXT,
  CLIENT_REQUEST_CONSENT_VERSION,
  CLIENT_REQUEST_DIRECT_CONSENT_TEXT,
  CLIENT_REQUEST_DIRECT_CONSENT_VERSION,
  CLIENT_REQUEST_DIRECT_WINDOW_MS,
  CLIENT_REQUEST_MAX_LAWYERS,
  CLIENT_REQUEST_SHARING_NOTICE,
  CLIENT_REQUEST_REFERRAL_DISCLOSURE,
} from "../constants/client-request.constants";

/** Why the client can't ask for a lawyer on a case (CLIENT_HANDOFF_ERROR_CODES). */
type IneligibleReason = "NOT_UK_CASE" | "REGION_UNKNOWN" | "PERSONAL_INJURY_EXCLUDED" | "REQUEST_ALREADY_OPEN";

const REFUSALS: Record<IneligibleReason, { status: number; message: string }> = {
  NOT_UK_CASE: { status: 422, message: "Lawyers are only available for cases in the UK for now." },
  REGION_UNKNOWN: { status: 422, message: "Choose which part of the UK your case is in to ask for a lawyer." },
  PERSONAL_INJURY_EXCLUDED: { status: 422, message: "We can't connect personal injury cases with a lawyer yet." },
  REQUEST_ALREADY_OPEN: { status: 409, message: "You've already asked for a lawyer on this case." },
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** A client can withdraw until they've confirmed a lawyer. */
const WITHDRAWABLE: ClientRequestStatus[] = ["REQUESTED", "ROUTED", "CLAIMED", "QUOTED"];

export interface NewClientRequest {
  caseId: string;
  note?: string;
  consentVersion: string;
  consentAccepted: boolean;
  /** The lawyer the client asked for by name, from the marketplace: only they are offered it at first. */
  lawyerId?: string;
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

/** The quote as the client first saw it (#512): the type, the lawyer's amount and message. Kept for
 * older apps; `quotation` has the platform fee, the total and the expiry. */
function quoteDto(claim: ClaimForClient) {
  if (!claim.quotedAt) return null;
  return {
    type: claim.quoteType,
    amount: { amountMinor: claim.quoteAmountMinor, currency: claim.quoteCurrency },
    message: claim.quoteMessage,
    sentAt: claim.quotedAt,
  };
}

/** The lawyer's quotation once sent: a draft is the lawyer's own, never shown to the client. */
function quotationFor(claim: ClaimForClient) {
  return claim.quotation && claim.quotation.status !== "DRAFT" ? quotationDto(claim.quotation) : null;
}

/** The request's status as the client sees it (shownStatus). */
function statusForClient(r: ClientRequestForClient): ClientRequestStatus {
  return shownStatus(r.status, r.claims);
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

/** ClientRefundSummary: what the client paid the lawyer they hired, what's come back, and, when the
 * lawyer stopped acting, where that refund stands (never why they left). */
function refundSummary(payment: QuotationPayment & { refunds: QuotationRefund[] }, exit: LawyerExit | null): ClientRefundSummary {
  const money = (amountMinor: number) => ({ amountMinor, currency: payment.currency as "GBP" });
  return {
    paid: money(payment.amountMinor),
    refunded: money(payment.refundedMinor),
    pending: money(payment.refunds.filter((r) => r.status === "PENDING").reduce((sum, r) => sum + r.amountMinor, 0)),
    refunds: payment.refunds.map((r) => ({ id: r.id, amount: money(r.amountMinor), status: r.status, createdAt: r.createdAt.toISOString() })),
    lawyerExit: exit ? { status: exit.status, createdAt: exit.createdAt.toISOString(), settledAt: exit.settledAt?.toISOString() ?? null } : null,
  };
}

/** The refund summary of each request whose hired lawyer the client paid through ilovelawyer. */
async function refundsFor(requests: ClientRequestForClient[]): Promise<Map<string, ClientRefundSummary>> {
  const engaged = requests.flatMap((r) => r.claims.filter((c) => c.outcome === "ENGAGED" && c.quotation).map((c) => ({ requestId: r.id, quotationId: c.quotation!.id })));
  if (!engaged.length) return new Map();
  const [payments, exits] = await Promise.all([QuotationPaymentRepo.findPaidWithRefunds(engaged.map((e) => e.quotationId)), LawyerExitRepo.findByRequests(engaged.map((e) => e.requestId))]);
  const out = new Map<string, ClientRefundSummary>();
  for (const { requestId, quotationId } of engaged) {
    // The newest attempt that took money (there's one).
    const payment = payments.find((p) => p.quotationId === quotationId);
    if (payment) out.set(requestId, refundSummary(payment, exits.get(requestId) ?? null));
  }
  return out;
}

/** LawyerRequestForClient in the contract. Several lawyers (phase 5): `lawyers` is everyone on the
 * request now, oldest first, each with their quote once sent (`claimId` is what confirm and decline
 * take, `quotation.id` what accept, reject and pay take); `pickByAt` is when it expires without a
 * pick; `openToLawyers`, whether more lawyers can still take it up (its 48h open and a place free),
 * so the app doesn't promise quotes that can't come. `lawyer`/`quote`/`quotation` stay for one
 * lawyer (the one hired, or the only quote). The disclosure is what the client acknowledges to
 * accept. `awaitingPayment`: the client accepted a quotation and hasn't paid it yet. */
function toDto(r: ClientRequestForClient, refund: ClientRefundSummary | null = null) {
  const one = oneLawyer(r);
  const lawyers = r.claims.map((c) => ({ claimId: c.id, joinedAt: c.claimedAt, lawyer: lawyerDto(c), quote: quoteDto(c), quotation: quotationFor(c) }));
  const hasQuote = lawyers.some((l) => l.quote);
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
    openToLawyers:
      r.status === "ROUTED" &&
      !!r.routingExpiresAt &&
      r.routingExpiresAt > new Date() &&
      r.claims.filter((c) => c.outcome === null).length < (r.requestedOnly ? 1 : CLIENT_REQUEST_MAX_LAWYERS),
    // The lawyer the client asked for by name, if they did. `requestedOnly`: only they are offered
    // it, until `routingExpiresAt`; then (or once they pass) it goes to every matching lawyer.
    requestedLawyer: r.requestedLawyer ? { id: r.requestedLawyer.id, name: r.requestedLawyer.name ?? "" } : null,
    requestedOnly: r.requestedOnly,
    routingExpiresAt: r.status === "ROUTED" ? r.routingExpiresAt : null,
    lawyer: one ? lawyerDto(one) : null,
    quote: one ? quoteDto(one) : null,
    quotation: one ? quotationFor(one) : null,
    // A quote accepted before quotation payments has no accepted amount: it's paid outside ilovelawyer.
    awaitingPayment: r.status === "CONFIRMED" && one?.quotation?.status === "ACCEPTED" && one.quotation.acceptedAmountMinor !== null,
    referralDisclosure: hasQuote ? CLIENT_REQUEST_REFERRAL_DISCLOSURE : null,
    sharingNotice: hasQuote ? CLIENT_REQUEST_SHARING_NOTICE : null,
    engagedAt: r.engagedAt,
    closedAt: r.closedAt,
    closedBy: r.closedBy,
    feedback: r.feedback ? { rating: r.feedback.rating, comment: r.feedback.comment, createdAt: r.feedback.createdAt } : null,
    // The lawyer's "the work is finished": waiting on the client to confirm it, or answered.
    completion: completionDto(r),
    // What the client paid the lawyer they hired, and any refunds: null until paid through ilovelawyer.
    refund,
  };
}

/**
 * A client asking for a lawyer on one of their own cases (#507): only on a UK case that isn't
 * personal injury, one open request per case, with the consent text they agreed to recorded. Making
 * one starts its anonymised brief (#508) and routes it to every matching lawyer (#509); claiming
 * it is a later issue (#511).
 */
export default class ClientRequestSvc {
  /** What the client agrees to: asking every matching lawyer, or (`direct`) one lawyer by name first. */
  static consent(direct = false) {
    return direct
      ? { version: CLIENT_REQUEST_DIRECT_CONSENT_VERSION, consentText: CLIENT_REQUEST_DIRECT_CONSENT_TEXT, referralDisclosure: CLIENT_REQUEST_REFERRAL_DISCLOSURE }
      : { version: CLIENT_REQUEST_CONSENT_VERSION, consentText: CLIENT_REQUEST_CONSENT_TEXT, referralDisclosure: CLIENT_REQUEST_REFERRAL_DISCLOSURE };
  }

  /** Whether the app should offer "Get a lawyer" on this case, and if not, why. */
  static async eligibility(workspace: ClientWorkspace, caseId: string): Promise<{ eligible: boolean; reason: IneligibleReason | null; openRequestId: string | null }> {
    const row = await ClientCaseRepo.findById(caseId, workspace.id);
    if (!row) throw new HttpError("Case not found", 404);
    const no = (reason: IneligibleReason, openRequestId: string | null = null) => ({ eligible: false, reason, openRequestId });

    if (row.outsideUk) return no("NOT_UK_CASE");
    // Nobody has said where it is yet (#973): ask, rather than call it outside the UK.
    if (!row.ukJurisdiction) return no("REGION_UNKNOWN");
    // Personal injury is spotted by the lawyer readiness check (Jev), which reads the chat.
    if ((row.lawyerReadiness as { blockedBy?: string } | null)?.blockedBy === "PERSONAL_INJURY") return no("PERSONAL_INJURY_EXCLUDED");
    const open = await ClientRequestRepo.findOpenForCase(caseId);
    if (open) return no("REQUEST_ALREADY_OPEN", open.id);
    return { eligible: true, reason: null, openRequestId: null };
  }

  static async create(workspace: ClientWorkspace, clientId: string, input: NewClientRequest) {
    if (!input.consentAccepted) throw new HttpError("Agree to the consent to ask for a lawyer.", 400, "CONSENT_REQUIRED");
    const consent = ClientRequestSvc.consent(!!input.lawyerId);
    if (input.consentVersion !== consent.version) {
      throw new HttpError("The consent text has changed. Read it again before sending.", 409, "CONSENT_VERSION_STALE", { version: consent.version });
    }
    const check = await ClientRequestSvc.eligibility(workspace, input.caseId);
    if (check.reason) {
      const refusal = REFUSALS[check.reason];
      throw new HttpError(refusal.message, refusal.status, check.reason, check.openRequestId ? { openRequestId: check.openRequestId } : undefined);
    }
    // A lawyer who stopped acting on this case (a Lawyer Exit, #972) isn't offered it again.
    const leftCase = await LawyerExitRepo.lawyerIdsForCase(input.caseId);
    if (input.lawyerId && leftCase.includes(input.lawyerId)) {
      throw new HttpError("This lawyer stopped acting on this case, so they can't be asked to take it again. Ask another lawyer.", 422, "LAWYER_LEFT_CASE");
    }
    const requestedLawyer = input.lawyerId ? await ClientRequestSvc.assertLawyerTakes(workspace, input.caseId, input.lawyerId) : null;
    const created = await ClientRequestRepo.create({
      caseId: input.caseId,
      clientId,
      note: input.note?.trim() ?? "",
      consentVersion: input.consentVersion,
      consentAcceptedAt: new Date(),
      requestedLawyerId: requestedLawyer?.id ?? null,
      excludedLawyerIds: leftCase,
    });
    // The anonymised brief lawyers will see (#508). Written in the background: the AI takes a while.
    ClientRequestBriefSvc.generateInBackground(created.id);
    // Routed (#509) straight away, even with zero current matches — the client just sees "Finding
    // a lawyer" either way; EXPIRED (#510) is what ends that wait. Asked by name: only that lawyer,
    // for their 24h, then every matching lawyer (ClientRequestNotifySvc.openDirectDue).
    const routed = await ClientRequestMatchingSvc.route(created.id, requestedLawyer ? CLIENT_REQUEST_DIRECT_WINDOW_MS : undefined);
    // Brand new, so nobody has claimed or quoted it.
    return toDto({ ...routed, claims: [], feedback: null, requestedLawyer });
  }

  /** The lawyer a client asks for by name: verified, taking requests, and taking cases like this one
   * (its area and part of the UK). 404 LAWYER_NOT_FOUND, else 422 LAWYER_NOT_AVAILABLE or
   * LAWYER_NOT_A_MATCH. */
  private static async assertLawyerTakes(workspace: ClientWorkspace, caseId: string, lawyerId: string) {
    const lawyer = await LawyerProfileRepo.findVerifiedById(lawyerId);
    if (!lawyer) throw new HttpError("That lawyer isn't listed.", 404, "LAWYER_NOT_FOUND");
    if (!ClientRequestMatchingSvc.isAvailable(lawyer)) throw new HttpError("This lawyer isn't taking new requests right now.", 422, "LAWYER_NOT_AVAILABLE");
    const row = await ClientCaseRepo.findById(caseId, workspace.id);
    if (!row) throw new HttpError("Case not found", 404);
    if (!ClientRequestMatchingSvc.matches(lawyer, { caseAreas: row.caseAreas, ukJurisdiction: row.ukJurisdiction })) {
      throw new HttpError("This lawyer doesn't take cases like this one, or not in your part of the UK.", 422, "LAWYER_NOT_A_MATCH");
    }
    const name = (await LawyerProfileRepo.findForMarketplace(lawyerId))[0]?.user.name ?? "";
    return { id: lawyerId, name };
  }

  static async list(clientId: string, query: { caseId?: string; page: number; limit: number }) {
    const { total, data } = await ClientRequestRepo.listForClient(clientId, query.caseId, query.page, query.limit);
    const refunds = await refundsFor(data);
    return { total, data: data.map((r) => toDto(r, refunds.get(r.id) ?? null)) };
  }

  static async get(clientId: string, id: string) {
    return ClientRequestSvc.view(clientId, id);
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
    return ClientRequestSvc.view(clientId, id);
  }

  /**
   * The client accepts one lawyer's quotation (several lawyers since phase 5), having acknowledged how
   * ilovelawyer is paid: the request is CONFIRMED, the quotation ACCEPTED with its total fixed, and
   * the other lawyers on it are told the client chose someone else. The client then pays it
   * (QuotationPaymentSvc.start), and paying engages the request. A quotation with nothing to pay (a
   * free first consultation) engages it at once. `claimId` (or `quotationId`) names the quote; it can
   * be left out when there's only one. 409 QUOTATION_EXPIRED after the lawyer's expiry. Nothing is
   * charged to the lawyer.
   */
  static async confirm(clientId: string, id: string, input: { disclosureAcknowledged: boolean; claimId?: string; quotationId?: string }) {
    if (!input.disclosureAcknowledged) {
      throw new HttpError("Read and acknowledge how ilovelawyer is paid before accepting.", 400, "DISCLOSURE_NOT_ACKNOWLEDGED");
    }
    const request = await ClientRequestSvc.load(clientId, id);
    const claimId = input.quotationId ? (request.claims.find((c) => c.quotation?.id === input.quotationId)?.id ?? "-") : input.claimId;
    const chosen = ClientRequestSvc.quoteToAnswer(request, claimId, "This lawyer can't be confirmed now.");
    if (!chosen.quotation) throw new HttpError("This lawyer can't be confirmed now.", 409, "INVALID_REQUEST_STATUS", { status: statusForClient(request) });
    const accepted = await QuotationRepo.accept(id, chosen.quotation.id);
    if ("refused" in accepted) {
      if (accepted.refused === "EXPIRED") throw new HttpError("This quote has expired.", 409, "QUOTATION_EXPIRED");
      const now = await ClientRequestSvc.load(clientId, id);
      throw new HttpError("This lawyer can't be confirmed now.", 409, "INVALID_REQUEST_STATUS", { status: now.status ?? request.status });
    }

    const lawyerId = accepted.claim.lawyerId;
    await OrganizationRepo.writeAudit({
      caseId: request.caseId,
      actorId: clientId,
      action: "client_request.confirmed",
      payload: { requestId: id, quotationId: accepted.quotation.id, lawyerId },
    });
    const updated: ClientRequestUpdatedEvent = { requestId: id, status: "CONFIRMED", updatedAt: new Date().toISOString() };
    emitToUser(lawyerId, "client-request:updated", updated);
    const free = accepted.quotation.acceptedAmountMinor === 0;
    if (!free) {
      await NotificationSvc.create({
        userId: lawyerId,
        type: "CLIENT_REQUEST",
        title: "A client accepted your quote",
        message: "You'll be engaged as soon as the client pays it. Nothing is charged to you.",
        link: `/client-requests/${id}`,
      }).catch((err) => logger.error("Client request: failed to create notification", { err, requestId: id }));
    }
    for (const other of accepted.notChosen) {
      emitToUser(other, "client-request:updated", updated);
      await NotificationSvc.create({
        userId: other,
        type: "CLIENT_REQUEST",
        title: "The client chose another lawyer",
        message: "The client hired another lawyer for this request. Nothing was charged to you.",
        link: "/client-requests?view=history",
      }).catch((err) => logger.error("Client request: failed to create notification", { err, requestId: id }));
    }

    if (free && (await QuotationRepo.engageUnpaid(accepted.quotation))) {
      await QuotationPaymentSvc.afterEngaged(accepted.quotation, accepted.claim, 0, null);
    }
    return ClientRequestSvc.view(clientId, id);
  }

  /** The client accepts a quotation by its id (POST .../quotations/:quotationId/accept). */
  static async accept(clientId: string, id: string, quotationId: string, input: { disclosureAcknowledged: boolean }) {
    return ClientRequestSvc.confirm(clientId, id, { ...input, quotationId });
  }

  /** The client rejects a quotation by its id (POST .../quotations/:quotationId/reject). */
  static async reject(clientId: string, id: string, quotationId: string, input: { reason?: string }) {
    const request = await ClientRequestSvc.load(clientId, id);
    const claim = request.claims.find((c) => c.quotation?.id === quotationId);
    if (!claim) throw new HttpError("Quote not found", 404);
    return ClientRequestSvc.decline(clientId, id, { ...input, claimId: claim.id });
  }

  /** The client declines one lawyer's quote (#513; several lawyers in phase 5): its quotation is
   * REJECTED, nothing is charged,
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
    return ClientRequestSvc.view(clientId, id);
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
    // The lawyer's earning starts its hold now, as when they close it themselves.
    const terms = await PayoutSettingsSvc.forTenant(await ClientPricingSvc.tenantIdForClient(clientId));
    if (!(await ClientRequestRepo.close(id, "CLIENT", now, { holdUntil: new Date(now.getTime() + terms.earningsHoldDays * DAY_MS) })).closed) {
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
    for (const walletId of await WalletRepo.walletsForRequest(id)) await WalletSvc.changedById(walletId);

    return ClientRequestSvc.view(clientId, id);
  }

  /** The client confirms the lawyer's "the work is finished": the engagement closes, as the lawyer's
   * close (EngagementCompletionSvc). 409 COMPLETION_NOT_REQUESTED when the lawyer hasn't asked. */
  static async confirmCompletion(clientId: string, id: string) {
    await ClientRequestSvc.load(clientId, id);
    await EngagementCompletionSvc.confirm(clientId, id);
    return ClientRequestSvc.view(clientId, id);
  }

  /** The client says the work isn't finished yet, and why: the engagement carries on, and the lawyer
   * is told. 409 COMPLETION_NOT_REQUESTED when the lawyer hasn't asked. */
  static async declineCompletion(clientId: string, id: string, input: { reason: string }) {
    await ClientRequestSvc.load(clientId, id);
    await EngagementCompletionSvc.decline(clientId, id, input.reason.trim());
    return ClientRequestSvc.view(clientId, id);
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

  /** The request as the client app reads it, with its refund summary. */
  private static async view(clientId: string, id: string) {
    const request = await ClientRequestSvc.load(clientId, id);
    return toDto(request, (await refundsFor([request])).get(id) ?? null);
  }

  private static async load(clientId: string, id: string) {
    const request = await ClientRequestRepo.findForClient(id, clientId);
    if (!request) throw new HttpError("Request not found", 404);
    return request;
  }
}
