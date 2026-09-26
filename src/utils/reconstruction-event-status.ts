import type { AssertionCheck } from "./assertion-check";
import type { EventPhrasing } from "./event-phrasing-jev";

/**
 * Case Reconstruction's per-event badge, derived from one Jev assertion check of the event against
 * the passage its sourceRef points at. Pure, so the benchmark and the service share one rule.
 *
 * DISPUTED means something in the record conflicts with the event: its own source contradicts it, or
 * another document does. It is never the answer to "could not be confirmed" — a failed check, a claim
 * only one party makes, or a witness nobody backs are all UNVERIFIED. That "contested" only ever
 * follows from a conflict is the same reasoning that gives CONTRADICTED its confidence floor in
 * assertion-check.ts.
 */
export const EVENT_STATUSES = ["VERIFIED", "DISPUTED", "UNVERIFIED"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/**
 * A SUPPORTED verdict below this confidence is not enough to put a Verified (or Disputed) badge on
 * an event — it becomes Unverified. Found by the first end-to-end run, where "paid for 8.0 hours"
 * came out Verified on a 24% SUPPORTED. Provisional, like the other Jev floors: re-set from the
 * benchmark.
 */
export const SUPPORT_MIN_CONFIDENCE = 0.7;

/** What the rest of the case says about an event, beyond the passage its own source quote sits in. */
export interface CrossDocumentEvidence {
  /** An independent document shows the event — settles a witness account or a party's own assertion. */
  corroborated?: boolean;
  /** Another document says the opposite. Wins over everything but the event's own source being
   * contradicted (which is Disputed already). */
  contradicted?: boolean;
}

/**
 * Status from the Jev check of the event against its own source, adjusted by what other documents
 * say. One passage cannot tell whether a party's or a witness's account stands alone, and it cannot
 * see a contradiction that lives in a different document, so the caller supplies both.
 */
export function deriveEventStatus(
  check: Pick<AssertionCheck, "verdict" | "evidenceKind" | "confidence">,
  evidence: CrossDocumentEvidence = {},
): EventStatus {
  if (check.verdict === "CONTRADICTED" || evidence.contradicted) return "DISPUTED";
  if (check.verdict === "UNSUPPORTED" || check.confidence < SUPPORT_MIN_CONFIDENCE) return "UNVERIFIED";
  switch (check.evidenceKind) {
    case "SHOWN_BY_DOCUMENT":
    case "ESTABLISHED":
      return "VERIFIED";
    case "ASSERTED_BY_PARTY":
      // Not DISPUTED: that needs positive evidence of conflict, and "nothing else in the record
      // confirms it" is silence, not conflict (Doe's uncontested start date came out Disputed).
      return evidence.corroborated ? "VERIFIED" : "UNVERIFIED";
    case "STATED_BY_WITNESS":
      return evidence.corroborated ? "VERIFIED" : "UNVERIFIED";
  }
}

export const ALLEGATION_PHRASED_NOTE = "Phrased as an allegation, so it was not checked against its source — restate the event as a fact.";

/**
 * What an event's phrasing decides before any source check: an ALLEGATION is flagged Unverified
 * with a note and never sent to the assertion check (which could only answer "unsupported" and read
 * as noise); a FACT proceeds to the ordinary check, signalled by null.
 */
export function outcomeForPhrasing(phrasing: EventPhrasing): { status: EventStatus; statusNote: string } | null {
  return phrasing === "ALLEGATION" ? { status: "UNVERIFIED", statusNote: ALLEGATION_PHRASED_NOTE } : null;
}
