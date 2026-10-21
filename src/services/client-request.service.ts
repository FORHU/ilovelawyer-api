import type { ClientRequest, ClientRequestStatus } from "@prisma/client";
import ClientRequestRepo from "../repositories/client-request.repository";
import ClientCaseRepo from "../repositories/client-case.repository";
import ClientRequestBriefSvc from "./client-request-brief.service";
import HttpError from "../utils/http-error";
import type { ClientWorkspace } from "./client-case.service";
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

/** LawyerRequestForClient in the contract. The lawyer, quote and engagement fields are filled by
 * later issues (#512 onwards); until then they're always empty. */
function toDto(r: ClientRequest) {
  return {
    id: r.id,
    caseId: r.caseId,
    status: r.status,
    note: r.note,
    consentVersion: r.consentVersion,
    consentAcceptedAt: r.consentAcceptedAt,
    createdAt: r.createdAt,
    lawyer: null,
    quote: null,
    referralDisclosure: null,
    engagedAt: null,
    closedAt: null,
    closedBy: null,
    feedback: null,
  };
}

/**
 * A client asking for a lawyer on one of their own cases (#507): only on a paid UK case that isn't
 * personal injury, one open request per case, with the consent text they agreed to recorded. Making
 * one starts its anonymised brief (#508); routing and a lawyer claiming it are later issues.
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
    return toDto(created);
  }

  static async list(clientId: string, query: { caseId?: string; page: number; limit: number }) {
    const { total, data } = await ClientRequestRepo.listForClient(clientId, query.caseId, query.page, query.limit);
    return { total, data: data.map(toDto) };
  }

  static async get(clientId: string, id: string) {
    return toDto(await ClientRequestSvc.load(clientId, id));
  }

  /** Until a lawyer is confirmed, the client can take the request back. */
  static async withdraw(clientId: string, id: string) {
    const request = await ClientRequestSvc.load(clientId, id);
    const moved = await ClientRequestRepo.transition(id, WITHDRAWABLE, { status: "WITHDRAWN", withdrawnAt: new Date() });
    if (!moved) {
      throw new HttpError("This request can't be withdrawn now.", 409, "INVALID_REQUEST_STATUS", { status: request.status });
    }
    return toDto(await ClientRequestSvc.load(clientId, id));
  }

  private static async load(clientId: string, id: string) {
    const request = await ClientRequestRepo.findForClient(id, clientId);
    if (!request) throw new HttpError("Request not found", 404);
    return request;
  }
}
