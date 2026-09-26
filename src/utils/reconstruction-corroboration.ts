import type { BundleFact } from "./bundle-facts";
import type { AssertionCheck } from "./assertion-check";
import { contentWords, overlapOf, DEFAULT_CANDIDATE_OPTIONS } from "./fact-pairs";
import { SUPPORT_MIN_CONFIDENCE } from "./reconstruction-event-status";

/**
 * Is a Case Reconstruction event backed by a second, independent document? Feeds the `corroborated`
 * flag of deriveEventStatus (reconstruction-event-status.ts), which is what lets a witness account
 * count as Verified instead of staying Unverified.
 *
 * Two steps, so a stray matching date is never enough: this pure prefilter finds date facts in
 * OTHER documents that state the event's date in a sentence about the same thing (the same
 * content-word thresholds the contradiction scan pairs facts with), then the caller asks Jev
 * whether that sentence really bears the event out (isCorroboratingCheck).
 */

export interface CorroborationQuery {
  /** YYYY-MM-DD — the event's date, normalised the way bundle-facts normalises. */
  eventDate: string;
  /** The event stated as a fact ("Doe was absent from 4 August"), not as an allegation. */
  proposition: string;
  /** The document the event's own sourceRef points at; it can't corroborate itself. */
  sourceDocumentId: string;
}

export interface CorroborationCandidate {
  fact: BundleFact;
  overlap: number;
  sharedWords: number;
}

export function findCorroborationCandidates(
  query: CorroborationQuery,
  facts: BundleFact[],
  opts: { minOverlap: number; minSharedWords: number } = DEFAULT_CANDIDATE_OPTIONS,
): CorroborationCandidate[] {
  const eventWords = contentWords(query.proposition);
  const out: CorroborationCandidate[] = [];
  for (const fact of facts) {
    if (fact.kind !== "date" || fact.value !== query.eventDate || fact.documentId === query.sourceDocumentId) continue;
    const { shared, overlap } = overlapOf(eventWords, contentWords(fact.sentence));
    if (shared < opts.minSharedWords || overlap < opts.minOverlap) continue;
    out.push({ fact, overlap, sharedWords: shared });
  }
  // Best first: overlap is a coefficient over the smaller word set, so it ties often — more shared
  // words breaks the tie. One candidate per document is enough, so keep only the strongest of each.
  out.sort((a, b) => b.overlap - a.overlap || b.sharedWords - a.sharedWords);
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.fact.documentId) ? false : (seen.add(c.fact.documentId), true)));
}

// Phrases by which a record says something is NOT in it. Deliberately broad: wrongly refusing to
// corroborate leaves an event Unverified, while wrongly corroborating puts a Verified badge on a
// fact the record only fails to contradict.
const ABSENCE_OF_RECORD_RE =
  /\bno\s+(?:\w+\s+){0,2}(?:entry|entries|record|records|trace|log|logged|note|mention|evidence|sign)\b|\bnot\s+(?:recorded|logged|noted|listed|shown|mentioned)\b|\bnothing\s+(?:recorded|on\s+file|logged)\b|\bnone\s+(?:recorded|on\s+file)\b/i;

/** True when a passage's only bearing on an event is that the record lacks something — "no entry
 * for M. Doe" shows she wasn't written down, not that she wasn't there. */
export function isAbsenceOfRecord(passage: string): boolean {
  return ABSENCE_OF_RECORD_RE.test(passage);
}

/** A second source corroborates only if it shows the event — another party's allegation or another
 * witness's recollection repeating it is not independent proof, and neither is a record's silence.
 * Pass the passage so absence-of-record wording can be excluded; without it that check is skipped. */
export function isCorroboratingCheck(check: Pick<AssertionCheck, "verdict" | "evidenceKind" | "confidence">, passage?: string): boolean {
  if (passage !== undefined && isAbsenceOfRecord(passage)) return false;
  return (
    check.verdict === "SUPPORTED" &&
    check.confidence >= SUPPORT_MIN_CONFIDENCE &&
    (check.evidenceKind === "SHOWN_BY_DOCUMENT" || check.evidenceKind === "ESTABLISHED")
  );
}
