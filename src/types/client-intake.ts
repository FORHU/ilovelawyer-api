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

/** One line of "Here's your story so far" (the new-client flow): what the client told us, said
 * back to them in their own terms and language. `text` may mark its key detail with **bold** and
 * carries no other markup; the app renders only that. A "DEADLINE" line is a date the client or a
 * document stated, never one worked out from a rule. */
export interface IntakeStoryLine {
  id: string;
  kind: "FACT" | "DEADLINE";
  text: string;
  sources: IntakeSource[];
}

export type IntakeStatus = "EMPTY" | "RUNNING" | "READY" | "FAILED" | "STALE";

export interface IntakeCompleteness {
  criteria: { key: string; label: string; met: boolean }[];
  ready: boolean;
}

/** #157's named field groups, per the ticket's own screenshot of the lawyer's case-draft view:
 * case title (set at case creation, not repeated here), type of action, venue, parties,
 * relationship, role & terms, reason given, witnesses, client wants, timeline. Not a second AI
 * extraction: parties/typeOfAction/venue are the deterministic case-creation form data (never
 * guessed), and the rest are CaseIntake's own already-extracted people/timeline/goals/relationship/
 * roleAndTerms/reasonGiven, split out and relabeled for the question-loop UI's fill-progress
 * display. relationship/roleAndTerms/reasonGiven are deliberately generic across practice areas
 * (e.g. "tenant and landlord" or "contract value and deliverables" read as naturally as an
 * employment case's "employee and employer" / "job title and salary") rather than gated to one
 * case type. See deriveFormFields (client-intake-extract.ts). */
export interface IntakeFormFields {
  parties: IntakePerson[];
  witnesses: IntakePerson[];
  /** The case's own area names (e.g. "Employment") — set at case creation, so this is empty only
   * when the client genuinely hasn't chosen one yet. */
  typeOfAction: string[];
  /** Jurisdiction or town, set at case creation; null when not chosen yet. */
  venue: string | null;
  timeline: IntakeEvent[];
  clientGoals: IntakeItem[];
  /** The nature of the relationship the claim arises from (employment, tenancy, contract, ...). */
  relationship: IntakeItem[];
  /** The client's role/position and the financial or contractual terms involved. */
  roleAndTerms: IntakeItem[];
  /** The reason the OTHER side gave for the disputed action, as stated — never inferred. */
  reasonGiven: IntakeItem[];
  /** Which of the groups above is still empty — the fill-progress list `ilovelawyer-client`'s
   * question loop reads to skip an already-answered question or show what's left. */
  missing: ("parties" | "witnesses" | "typeOfAction" | "venue" | "timeline" | "clientGoals" | "relationship" | "roleAndTerms" | "reasonGiven")[];
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
  /** "Here's your story so far": at most five lines, facts first, deadlines last. Not part of the
   * lawyer's anonymised brief (client-intake-redaction.ts keeps only what it names). */
  storySoFar: IntakeStoryLine[];
  /** From Lawyer Readiness (lawyer-readiness-jev.ts) when USE_JEV_LAWYER_READINESS is on; null
   * when the check is off or hasn't run yet. */
  completeness: IntakeCompleteness | null;
  formFields: IntakeFormFields;
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
  /** The client's note on it from the evidence step: what it is, in their words (noteBy CLIENT), or
   * the AI's draft the client left as it was (noteBy AI). Both null when it has none. */
  note: string | null;
  noteBy: "AI" | "CLIENT" | null;
}

/** A proof the evidence step suggested to the client, and what became of it: added (the document
 * that fills it is one of `documents`), still to add, or one the client said they don't have. */
export interface IntakePackageEvidence {
  id: string;
  title: string;
  why: string;
  state: "ADDED" | "OPEN" | "DISMISSED";
  documentId: string | null;
}

export interface IntakePackageForLawyer {
  requestId: string;
  caseId: string;
  caseDetails: IntakePackageCaseDetails;
  intake: CaseIntake;
  transcript: IntakePackageMessage[];
  documents: IntakePackageDocument[];
  /** Empty when the case never went through the evidence step. */
  evidence: IntakePackageEvidence[];
}
