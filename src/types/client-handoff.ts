/**
 * The UK client-to-lawyer hand-off contract (FORHU/ilovelawyer-app#862, ilovelawyer-api#503):
 * the values and socket events both apps rely on. The REST endpoints and shapes are in
 * swagger/client-handoff.ts (served at /api-docs and /api-docs.json). Most of this is built
 * (#504–#519); routes still landing say so in their swagger description.
 *
 * The two frontends have no shared package, so ilovelawyer-app and ilovelawyer-client copy this
 * file as is. Change it here first.
 *
 * Data model: docs/adr/0016-client-app-shares-the-uk-api.md.
 */

/** A Client Request's lifecycle. A client declining a quote, a lawyer releasing a claim and a
 * claim lapsing after 24h all send the request back to ROUTED. The claim that ended keeps its
 * ClaimOutcome. So DECLINED is a claim outcome, not a request status. */
export const CLIENT_REQUEST_STATUSES = [
  "REQUESTED", // created, brief being generated
  "ROUTED", // brief sent to every matching lawyer
  "CLAIMED", // one lawyer holds it for 24h: conflict check, then quote
  "QUOTED", // quote sent; the client confirms or declines
  "CONFIRMED", // the client confirmed; the per-case fee is being charged (or failed and awaits a new card)
  "ENGAGED", // fee paid; the lawyer has read-only access to the client's case
  "CLOSED", // the lawyer closed or the client ended the engagement; live access ended
  "EXPIRED", // unclaimed 48h after routing; ops alerted
  "WITHDRAWN", // the client withdrew before engagement
] as const;
export type ClientRequestStatus = (typeof CLIENT_REQUEST_STATUSES)[number];

/** The lifecycle's nine statuses, as a client or lawyer actually reads them: five stages for the
 * main path, plus EXPIRED and WITHDRAWN shown on their own. Each app's UI writes its own copy for
 * a stage (the client and the lawyer read the same stage differently) — stage() and
 * STAGE_LABELS below are the shared default, for anywhere a short, generic label is enough
 * (a list row, a badge). REQUESTED and ROUTED read the same ("waiting"): the client has nothing
 * to act on either way, and QUOTED/CONFIRMED both read as "accepted" (the fee is the platform's
 * business with the lawyer, not something the client watches). */
export const CLIENT_REQUEST_STAGES = ["waiting", "review", "accepted", "ongoing", "done", "expired", "withdrawn"] as const;
export type ClientRequestStage = (typeof CLIENT_REQUEST_STAGES)[number];

export const CLIENT_REQUEST_STAGE_BY_STATUS: Record<ClientRequestStatus, ClientRequestStage> = {
  REQUESTED: "waiting",
  ROUTED: "waiting",
  CLAIMED: "review",
  QUOTED: "accepted",
  CONFIRMED: "accepted",
  ENGAGED: "ongoing",
  CLOSED: "done",
  EXPIRED: "expired",
  WITHDRAWN: "withdrawn",
};

export const CLIENT_REQUEST_STAGE_LABELS: Record<ClientRequestStage, string> = {
  waiting: "Looking for a lawyer",
  review: "A lawyer is reviewing your case",
  accepted: "Quote received",
  ongoing: "Lawyer confirmed",
  done: "Closed",
  expired: "No lawyer found",
  withdrawn: "Withdrawn",
};

export function clientRequestStage(status: ClientRequestStatus): ClientRequestStage {
  return CLIENT_REQUEST_STAGE_BY_STATUS[status];
}

/** The shared default label for a status — a short, generic string fit for a list row or badge.
 * A fuller screen (a status timeline, a quote review) writes its own copy for the stage instead. */
export function clientRequestStatusLabel(status: ClientRequestStatus): string {
  return CLIENT_REQUEST_STAGE_LABELS[clientRequestStage(status)];
}

/** How a lawyer's claim on a request ended. */
export const CLAIM_OUTCOMES = ["RELEASED", "LAPSED", "DECLINED", "REASSIGNED", "WITHDRAWN", "ENGAGED"] as const;
export type ClaimOutcome = (typeof CLAIM_OUTCOMES)[number];

/** Matches the client app's case areas. Personal injury is not one of them: referral fees are
 * banned in personal-injury cases, so they are refused (PERSONAL_INJURY_EXCLUDED). */
export const PRACTICE_AREAS = ["EMPLOYMENT", "PROPERTY", "FAMILY", "CONSUMER", "OTHER"] as const;
export type PracticeArea = (typeof PRACTICE_AREAS)[number];

/** Same values as UK_JURISDICTIONS in validation/case.validation.ts. */
export const UK_JURISDICTIONS = ["England and Wales", "Scotland", "Northern Ireland"] as const;
export type UkJurisdiction = (typeof UK_JURISDICTIONS)[number];

/** Who regulates a solicitor, and so which register verifies them (#506). */
export const LAWYER_REGULATORS = ["SRA", "LSS", "LSNI"] as const;
export type LawyerRegulator = (typeof LAWYER_REGULATORS)[number];

/** AI-assessed from the case: URGENT has a hearing or deadline within 7 days, SOON within 30. */
export const REQUEST_URGENCIES = ["ROUTINE", "SOON", "URGENT"] as const;
export type RequestUrgency = (typeof REQUEST_URGENCIES)[number];

export const QUOTE_TYPES = ["FIXED_FEE", "FIRST_CONSULTATION"] as const;
export type QuoteType = (typeof QUOTE_TYPES)[number];

export const RELEASE_REASONS = ["CONFLICT", "CAPACITY", "OUT_OF_SCOPE", "OTHER"] as const;
export type ReleaseReason = (typeof RELEASE_REASONS)[number];

export const LAWYER_VERIFICATION_STATUSES = ["UNSUBMITTED", "PENDING", "VERIFIED", "REJECTED"] as const;
export type LawyerVerificationStatus = (typeof LAWYER_VERIFICATION_STATUSES)[number];

export const CHARGE_KINDS = ["PER_CASE_FEE", "AI_TOP_UP"] as const;
export type ChargeKind = (typeof CHARGE_KINDS)[number];

export const CHARGE_STATUSES = ["PENDING", "SUCCEEDED", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED"] as const;
export type ChargeStatus = (typeof CHARGE_STATUSES)[number];

/** WARNING from 80% of the engagement's AI budget; EXHAUSTED at 100%, when AI actions stop. */
export const AI_BUDGET_STATES = ["OK", "WARNING", "EXHAUSTED"] as const;
export type AiBudgetState = (typeof AI_BUDGET_STATES)[number];
export const AI_BUDGET_WARNING_PERCENT = 80;

/** Amounts in the currency's minor unit (pence). Prices are placeholders until
 * FORHU/ilovelawyer-app#846 and are read from config, never hard-coded in an app. */
export interface Money {
  amountMinor: number;
  currency: "GBP";
}

/** `code` on an error response ({ message, code, ...details }) for the hand-off routes. */
export const CLIENT_HANDOFF_ERROR_CODES = {
  // Client app
  NOT_UK_CASE: "NOT_UK_CASE", // 422: the case has no UK jurisdiction ("Not available yet")
  PERSONAL_INJURY_EXCLUDED: "PERSONAL_INJURY_EXCLUDED", // 422
  CASE_NOT_PAID: "CASE_NOT_PAID", // 422: the client hasn't paid for the case yet
  REQUEST_ALREADY_OPEN: "REQUEST_ALREADY_OPEN", // 409: the case already has a request that isn't closed, expired or withdrawn
  CONSENT_REQUIRED: "CONSENT_REQUIRED", // 400
  CONSENT_VERSION_STALE: "CONSENT_VERSION_STALE", // 409: the consent text changed; show the new one
  DISCLOSURE_NOT_ACKNOWLEDGED: "DISCLOSURE_NOT_ACKNOWLEDGED", // 400: confirm without the referral-fee disclosure
  // Lawyer app
  NOT_UK_TENANT: "NOT_UK_TENANT", // 403
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE", // 422: details.missing lists the fields
  LAWYER_NOT_VERIFIED: "LAWYER_NOT_VERIFIED", // 403
  REQUEST_ALREADY_CLAIMED: "REQUEST_ALREADY_CLAIMED", // 409: another lawyer won the claim
  CARD_REQUIRED: "CARD_REQUIRED", // 402: no card on the organization; add one through POST /organizations/{id}/billing/card/setup-session
  CLAIM_EXPIRED: "CLAIM_EXPIRED", // 409: the 24h hold ended
  CHARGE_FAILED: "CHARGE_FAILED", // 402: the per-case fee or a top-up was declined
  ENGAGEMENT_AI_BUDGET_SPENT: "ENGAGEMENT_AI_BUDGET_SPENT", // 403: top up to continue
  ENGAGEMENT_CLOSED: "ENGAGEMENT_CLOSED", // 409: the thread is read-only after close
  REASSIGN_TARGET_NOT_ELIGIBLE: "REASSIGN_TARGET_NOT_ELIGIBLE", // 400
  // Both
  INVALID_REQUEST_STATUS: "INVALID_REQUEST_STATUS", // 409: details.status is the current status
  // Admin
  REFUND_EXCEEDS_CHARGE: "REFUND_EXCEEDS_CHARGE", // 400
} as const;
export type ClientHandoffErrorCode = keyof typeof CLIENT_HANDOFF_ERROR_CODES;

// ── Socket events ────────────────────────────────────────────────────────────
// Sent on the existing single connection (lib/socket.ts) to user rooms, best effort. The REST
// routes are the source of truth, so a client refetches on any of these. No new rooms are
// needed: a lawyer's case-room events (ai-job:*) work on an engaged case as on any shared case,
// and closing reuses shared-cases:changed { caseId, shared: false }.

/** To each matching lawyer when a request is routed to them (also an email and a notification). */
export interface ClientRequestNewEvent {
  requestId: string;
  practiceArea: PracticeArea;
  ukJurisdiction: UkJurisdiction;
  urgency: RequestUrgency;
  /** When it expires if nobody claims it (48h after routing). */
  routingExpiresAt: string;
}

/** To every other matching lawyer once someone claims, withdraws or it expires: drop it from
 * the inbox. */
export interface ClientRequestTakenEvent {
  requestId: string;
}

/** To the client and the lawyer holding the request whenever its status changes (quote sent,
 * confirmed, charge failed, engaged, closed, expired, withdrawn, back to ROUTED). */
export interface ClientRequestUpdatedEvent {
  requestId: string;
  status: ClientRequestStatus;
  updatedAt: string;
}

/** To the claiming lawyer 2h before their 24h hold ends (also an email). */
export interface ClientRequestClaimExpiringEvent {
  requestId: string;
  claimExpiresAt: string;
}

/** To everyone on the engagement thread except the author. */
export interface EngagementMessageEvent {
  requestId: string;
  message: EngagementMessage;
}

/** To the engaged lawyer when the client adds a document to the case. The existing document:*
 * events only reach the uploader. */
export interface EngagementDocumentAddedEvent {
  requestId: string;
  caseId: string;
  documentId: string;
  filename: string;
  submittedBy: { id: string; name: string };
  submittedAt: string;
}

/** To the engaged lawyer when the client removes a document from the case. */
export interface EngagementDocumentRemovedEvent {
  requestId: string;
  caseId: string;
  documentId: string;
  filename: string;
}

/** To the engaged lawyer when the budget crosses 80% or 100%, and after a top-up. */
export interface EngagementAiBudgetEvent {
  requestId: string;
  percentUsed: number;
  state: AiBudgetState;
}

export interface EngagementMessage {
  id: string;
  requestId: string;
  author: { id: string | null; name: string; side: "CLIENT" | "LAWYER" | "SYSTEM" };
  body: string;
  /** Set when the message shares a document. */
  document: { id: string; filename: string; submittedBy: { id: string; name: string }; submittedAt: string } | null;
  createdAt: string;
}

/** A page of the engagement thread, oldest first, with how many of the other side's messages the
 * reader hasn't read (#517). */
export interface EngagementThreadPage {
  total: number;
  unread: number;
  data: EngagementMessage[];
}

export const CLIENT_HANDOFF_SOCKET_EVENTS = {
  REQUEST_NEW: "client-request:new",
  REQUEST_TAKEN: "client-request:taken",
  REQUEST_UPDATED: "client-request:updated",
  REQUEST_CLAIM_EXPIRING: "client-request:claim-expiring",
  ENGAGEMENT_MESSAGE: "engagement:message",
  ENGAGEMENT_DOCUMENT_ADDED: "engagement:document-added",
  ENGAGEMENT_DOCUMENT_REMOVED: "engagement:document-removed",
  ENGAGEMENT_AI_BUDGET: "engagement:ai-budget",
} as const;

export interface ClientHandoffSocketPayloads {
  "client-request:new": ClientRequestNewEvent;
  "client-request:taken": ClientRequestTakenEvent;
  "client-request:updated": ClientRequestUpdatedEvent;
  "client-request:claim-expiring": ClientRequestClaimExpiringEvent;
  "engagement:message": EngagementMessageEvent;
  "engagement:document-added": EngagementDocumentAddedEvent;
  "engagement:document-removed": EngagementDocumentRemovedEvent;
  "engagement:ai-budget": EngagementAiBudgetEvent;
}
