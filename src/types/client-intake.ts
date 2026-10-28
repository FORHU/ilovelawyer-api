/** The client app's Intake tab (ClientIntakeSvc): GET /api/client/cases/:caseId/intake, also
 * returned by POST .../intake/refresh. Mirrored in swagger-client-app.ts and in
 * ilovelawyer-client's src/lib/types.ts — change all three together.
 *
 * One AI extraction of the case, the chat and the documents, used by the client's Overview tab,
 * the intake chat's own context, and (via client-intake-redaction.ts) the lawyer's pre-claim
 * brief and post-engagement intake package. Deliberately has no case assessment: no points that
 * help or hurt the case, no computed deadlines, no outlook or win likelihood — those stay in the
 * lawyer's Terminal. A deadline only appears here when the client or a document actually states
 * one; nothing is calculated.
 */

/** Where a statement came from, so the client and the lawyer can both tell client-confirmed case
 * details from something said in chat from something found in a document. */
export type IntakeSourceKind = "CASE_DETAILS" | "CLIENT" | "DOCUMENT";

export interface IntakeSource {
  kind: IntakeSourceKind;
  /** Set for CLIENT: the message this came from. */
  messageId: string | null;
  /** Set for DOCUMENT: which file, and the page it was found on when known. */
  documentId: string | null;
  documentName: string | null;
  page: number | null;
}

export interface IntakeItem {
  id: string;
  text: string;
  sources: IntakeSource[];
}

export interface IntakeEvent extends IntakeItem {
  /** ISO 8601 date (YYYY-MM-DD). Null when no date could be placed at all. */
  date: string | null;
  datePrecision: "DAY" | "MONTH" | "YEAR" | "UNKNOWN";
}

export interface IntakePerson extends IntakeItem {
  name: string;
  /** How they're involved (e.g. "the employer", "a witness"). */
  role: string;
}

/** A deadline, hearing date or time limit exactly as the client or a document stated it — never
 * computed from a rule. */
export interface IntakeDeadline extends IntakeItem {
  date: string | null;
}

export interface IntakeGap {
  id: string;
  question: string;
  why: string;
}

/** Two or more sources disagreeing on a fact, date or detail. Never resolved silently: surfaced
 * for the client to clarify and the lawyer to see both sides of. */
export interface IntakeConflict {
  id: string;
  description: string;
  sources: IntakeSource[];
}

export type IntakeStatus = "EMPTY" | "RUNNING" | "READY" | "FAILED" | "STALE";

export interface IntakeCompleteness {
  criteria: { key: string; label: string; met: boolean }[];
  ready: boolean;
}

export interface CaseIntake {
  generatedAt: string | null;
  status: IntakeStatus;
  updates: { allowed: boolean; leftToday: number };
  /** AI-written, neutral. Always shown labelled as an AI summary, never as established fact. */
  summary: string | null;
  people: IntakePerson[];
  timeline: IntakeEvent[];
  facts: IntakeItem[];
  goals: IntakeItem[];
  concerns: IntakeItem[];
  questionsForLawyer: IntakeItem[];
  deadlines: IntakeDeadline[];
  missing: IntakeGap[];
  conflicts: IntakeConflict[];
  /** From Lawyer Readiness (lawyer-readiness-jev.ts) when USE_JEV_LAWYER_READINESS is on; null
   * when the check is off or hasn't run yet. */
  completeness: IntakeCompleteness | null;
}

/** The redacted shape of the intake a lawyer sees before claiming a request, folded into
 * CaseBrief.intake (client-handoff.ts). No names, no document names, no source ids — only what
 * client-intake-redaction.ts's toAnonymisedIntake keeps. People are roles only. */
export interface AnonymisedIntakeEvent {
  id: string;
  date: string | null;
  datePrecision: "DAY" | "MONTH" | "YEAR" | "UNKNOWN";
  text: string;
}
export interface AnonymisedIntakeItem {
  id: string;
  text: string;
}
export interface AnonymisedIntakeDeadline {
  id: string;
  date: string | null;
  text: string;
}
export interface AnonymisedIntakeGap {
  id: string;
  question: string;
  why: string;
}
export interface AnonymisedIntake {
  timeline: AnonymisedIntakeEvent[];
  goals: AnonymisedIntakeItem[];
  concerns: AnonymisedIntakeItem[];
  questionsForLawyer: AnonymisedIntakeItem[];
  deadlines: AnonymisedIntakeDeadline[];
  missing: AnonymisedIntakeGap[];
  completeness: IntakeCompleteness | null;
}

/** The full intake package an ENGAGED lawyer reads (GET /client-requests/:id/intake-package):
 * the live CaseIntake with its sources resolved to real names, plus the case details, the
 * transcript and the documents it points into. Read-only; every read is security-audited, same
 * as ClientRequestLawyerSvc.parties. */
export interface IntakePackageCaseDetails {
  title: string;
  /** The case's areas by name. */
  caseAreas: string[];
  ukJurisdiction: string | null;
  town: string | null;
  side: "CLAIMANT" | "RESPONDENT" | null;
  otherParties: { name: string; role: string }[];
  /** The client's own note to the lawyer, verbatim. */
  clientNote: string;
}

export interface IntakePackageMessage {
  id: string;
  role: "CLIENT" | "AI";
  text: string;
  createdAt: string;
}

export interface IntakePackageDocument {
  id: string;
  name: string;
  status: "PENDING" | "READY" | "FAILED";
  category: string | null;
  url: string | null;
}

export interface IntakePackageForLawyer {
  requestId: string;
  caseId: string;
  caseDetails: IntakePackageCaseDetails;
  intake: CaseIntake;
  transcript: IntakePackageMessage[];
  documents: IntakePackageDocument[];
}
