import type { ClientRequestStatus } from "@prisma/client";
import ClientRequestRepo, { type ClientRequestForClient } from "../repositories/client-request.repository";
import ClientCaseRepo from "../repositories/client-case.repository";
import ClientRequestBriefSvc from "./client-request-brief.service";
import ClientRequestMatchingSvc from "./client-request-matching.service";
import OrganizationChargeSvc from "./organization-charge.service";
import NotificationSvc from "./notification.service";
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
type IneligibleReason = "NOT_UK_CASE" | "PERSONAL_INJURY_EXCLUDED" | "CASE_NOT_PAID" | "REQUEST_ALREADY_OPEN";

const REFUSALS: Record<IneligibleReason, { status: number; message: string }> = {
  NOT_UK_CASE: { status: 422, message: "Lawyers are only available for cases in the UK for now." },
  PERSONAL_INJURY_EXCLUDED: { status: 422, message: "We can't connect personal injury cases with a lawyer yet." },
  CASE_NOT_PAID: { status: 422, message: "Pay for the case before asking for a lawyer." },
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
    // A solo practitioner's personal workspace isn't a firm.
    firmName: claim.organization.isPersonal ? null : claim.organization.name,
    regulator: profile?.ukRegistration?.regulator ?? null,
    registrationNumber: profile?.ukRegistration?.registrationNumber ?? null,
    practiceAreas: profile?.practiceAreas ?? [],
    qualifiedJurisdictions: profile?.ukRegistration?.qualifiedJurisdictions ?? [],
    languages: profile?.languages ?? [],
    bio: profile?.bio ?? "",
    firstConsultationFee: profile?.firstConsultationFeeMinor == null ? null : { amountMinor: profile.firstConsultationFeeMinor, currency: "GBP" },
    verifiedAt: profile?.verifiedAt ?? null,
  };
}

/** LawyerRequestForClient in the contract. From QUOTED, the lawyer, their quote and the referral
 * disclosure the client acknowledges to confirm (#512). The engagement fields come with #514. */
function toDto(r: ClientRequestForClient) {
  const quoted = r.claims[0] ?? null;
  return {
    id: r.id,
    caseId: r.caseId,
    status: r.status,
    note: r.note,
    consentVersion: r.consentVersion,
    consentAcceptedAt: r.consentAcceptedAt,
    createdAt: r.createdAt,
    lawyer: quoted ? lawyerDto(quoted) : null,
    quote: quoted
      ? {
          type: quoted.quoteType,
          amount: { amountMinor: quoted.quoteAmountMinor, currency: quoted.quoteCurrency },
          message: quoted.quoteMessage,
          sentAt: quoted.quotedAt,
        }
      : null,
    referralDisclosure: quoted ? CLIENT_REQUEST_REFERRAL_DISCLOSURE : null,
    engagedAt: r.engagedAt,
    closedAt: null,
    closedBy: null,
    feedback: null,
  };
}

/**
 * A client asking for a lawyer on one of their own cases (#507): only on a paid UK case that isn't
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
    if (!(await ClientRequestRepo.hasCasePayment(caseId))) return no("CASE_NOT_PAID");
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
    return toDto({ ...routed, claims: [] });
  }

  static async list(clientId: string, query: { caseId?: string; page: number; limit: number }) {
    const { total, data } = await ClientRequestRepo.listForClient(clientId, query.caseId, query.page, query.limit);
    return { total, data: data.map(toDto) };
  }

  static async get(clientId: string, id: string) {
    return toDto(await ClientRequestSvc.load(clientId, id));
  }

  /** Until a lawyer is confirmed, the client can take the request back. A lawyer holding it loses
   * their claim and is told; otherwise the lawyers it was routed to drop it from their inbox. */
  static async withdraw(clientId: string, id: string) {
    const request = await ClientRequestSvc.load(clientId, id);
    const now = new Date();
    const { moved, heldBy } = await ClientRequestRepo.withdraw(id, WITHDRAWABLE, now);
    if (!moved) {
      throw new HttpError("This request can't be withdrawn now.", 409, "INVALID_REQUEST_STATUS", { status: request.status });
    }
    if (heldBy) {
      const updated: ClientRequestUpdatedEvent = { requestId: id, status: "WITHDRAWN", updatedAt: now.toISOString() };
      emitToUser(heldBy, "client-request:updated", updated);
    } else {
      const taken: ClientRequestTakenEvent = { requestId: id };
      for (const lawyerId of await ClientRequestMatchingSvc.eligibleLawyerIds(id)) emitToUser(lawyerId, "client-request:taken", taken);
    }
    return toDto(await ClientRequestSvc.load(clientId, id));
  }

  /**
   * The client confirms the quoted lawyer (#513), having acknowledged the referral disclosure: QUOTED
   * -> CONFIRMED, and the lawyer's organization is charged the per-case fee straight away. When it goes
   * through the request is ENGAGED; when the card is declined it stays CONFIRMED, the firm is asked to
   * update the card, and the client waits. Confirming twice charges once.
   */
  static async confirm(clientId: string, id: string, input: { disclosureAcknowledged: boolean }) {
    if (!input.disclosureAcknowledged) {
      throw new HttpError("Read and acknowledge how ilovelawyer is paid before confirming.", 400, "DISCLOSURE_NOT_ACKNOWLEDGED");
    }
    const request = await ClientRequestSvc.load(clientId, id);
    const confirmed = await OrganizationChargeRepo.confirm(id, OrganizationChargeSvc.perCaseFee());
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
      message: "The client accepted your quote. The introduction fee is being charged to your organization's card.",
      link: `/client-requests/${id}`,
    }).catch((err) => logger.error("Client request: failed to create notification", { err, requestId: id }));

    // Engages the request, or tells the firm the card was declined.
    await OrganizationChargeSvc.attempt(confirmed.charge.id);
    return toDto(await ClientRequestSvc.load(clientId, id));
  }

  /** The client declines the quote (#513): nothing is charged, and the request goes back to other
   * lawyers without this one. The reason stays on the claim; the lawyer is told it ended. */
  static async decline(clientId: string, id: string, input: { reason?: string }) {
    const request = await ClientRequestSvc.load(clientId, id);
    const quoted = request.claims[0];
    if (request.status !== "QUOTED" || !quoted || quoted.outcome !== null) {
      throw new HttpError("There's no quote to decline now.", 409, "INVALID_REQUEST_STATUS", { status: request.status });
    }
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

  private static async load(clientId: string, id: string) {
    const request = await ClientRequestRepo.findForClient(id, clientId);
    if (!request) throw new HttpError("Request not found", 404);
    return request;
  }
}
