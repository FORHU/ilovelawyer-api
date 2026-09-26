import type { AssertionCheck } from "./assertion-check";
import type { BundleFact } from "./bundle-facts";
import type { EventPhrasingCheck } from "./event-phrasing-jev";
import type { ReconstructionEvent } from "./case-reconstruction-events-parse";
import { passageAround } from "./case-reconstruction-events-parse";
import { findCorroborationCandidates, isCorroboratingCheck } from "./reconstruction-corroboration";
import { contentWords, overlapOf } from "./fact-pairs";
import { deriveEventStatus, outcomeForPhrasing, SUPPORT_MIN_CONFIDENCE } from "./reconstruction-event-status";

/**
 * Turns audited events into events with a status: phrasing gate, then the Jev check of the
 * proposition against the passage around its quote, then — for an account one party or witness gave —
 * a sweep of what OTHER documents say on the same date: one that contradicts it makes the event
 * Disputed, one that independently shows it settles it. Without the sweep, an event is judged only
 * by its own source: the employer's "absent without leave" came out Verified because the letter says
 * so, while the payroll beside it says otherwise, and the employee's "reported for work" came out
 * Disputed with the attendance log confirming it (first end-to-end run). The Jev calls come in as `deps` so
 * the orchestration (who is skipped, who is checked, what a failure means) is testable without
 * Jev; CaseReconstructionSvc passes the real ones.
 *
 * Every failure path lands on UNVERIFIED, never DISPUTED: "could not check" must not read as
 * "contested" (see reconstruction-event-status.ts).
 */

export interface AssessDeps {
  classifyPhrasing: (proposition: string) => Promise<EventPhrasingCheck>;
  checkAssertion: (assertion: string, passage: string, citation?: string) => Promise<AssertionCheck>;
}

export interface AssessContext {
  facts: BundleFact[];
  /** Full indexed text per document — the passage a quote is read in comes from here. */
  fullTextByDocId: Map<string, string>;
  /** For naming the conflicting document in a note; falls back to the id. */
  docNames?: Map<string, string>;
}

const CONCURRENCY = 5;
/** Other documents checked per event in the sweep — each costs a Jev call. Documents with a sentence
 * on the event's date are ranked by how much of the event's wording appears in the passage Jev would
 * read, and the best few are read: "absent without leave" and "worked 8.0 hours" share no words, so
 * words can rank but never filter. Ranked on the passage, not the one sentence bundle-facts picked
 * (which can be a fragment — cut at "Mr." — and once ranked the contradicting affidavit fifth of five,
 * behind three unrelated records, so it was never read).
 *
 * Words are a weak ranker: the position paper says "petitioner", not "Doe", and ranked below payroll
 * rows that name her, so at four it was never read either. Six covers a bundle's usual spread on one
 * date; past six a real contradiction can be missed, which leaves the claim Unverified — the safe
 * direction, but a limit. Raising it is one Jev call per document per swept event. */
const MAX_SWEEP_DOCUMENTS = 6;

export const NO_SOURCE_NOTE = "No verified source quote for this event, so it could not be checked.";
export const CHECK_FAILED_NOTE = "Could not be checked against its source just now — regenerate to retry.";
export const CHECK_OFF_NOTE = "Not checked — the Jev source check is switched off.";

export function isJevReconstructionEnabled(): boolean {
  return process.env.USE_JEV_RECONSTRUCTION === "true";
}

export function markUnchecked(events: ReconstructionEvent[]): ReconstructionEvent[] {
  return events.map((e) => ({ ...e, status: "UNVERIFIED", statusNote: e.sourceRef ? CHECK_OFF_NOTE : NO_SOURCE_NOTE }));
}

export async function assessEvent(event: ReconstructionEvent, ctx: AssessContext, deps: AssessDeps): Promise<ReconstructionEvent> {
  if (!event.sourceRef) return { ...event, status: "UNVERIFIED", statusNote: NO_SOURCE_NOTE };

  // A failed phrasing call just means the ordinary check runs — safe, only noisier.
  const phrasing = await deps.classifyPhrasing(event.proposition).then(
    (r) => r.phrasing,
    () => "FACT" as const,
  );
  const skipped = outcomeForPhrasing(phrasing);
  if (skipped) return { ...event, ...skipped };

  const { docId, quote } = event.sourceRef;
  const passage = passageAround(ctx.fullTextByDocId.get(docId) ?? "", quote);
  let check: AssertionCheck;
  try {
    check = await deps.checkAssertion(event.proposition, passage, docId);
  } catch {
    return { ...event, status: "UNVERIFIED", statusNote: CHECK_FAILED_NOTE };
  }

  const sweep = needsSweep(event, check) ? await sweepOtherDocuments(event, docId, ctx, deps) : { corroboratedBy: [], contradictedBy: [] };
  const status = deriveEventStatus(check, { corroborated: sweep.corroboratedBy.length > 0, contradicted: sweep.contradictedBy.length > 0 });
  const conflict = sweep.contradictedBy[0];

  return {
    ...event,
    status,
    statusConfidence: check.confidence,
    statusNote: conflict
      ? conflictNote(sweep.contradictedBy, check, ctx)
      : check.confidence < SUPPORT_MIN_CONFIDENCE && check.verdict === "SUPPORTED"
        ? `The cited passage may bear this out, but not confidently enough to call it verified (${Math.round(check.confidence * 100)}%).`
        : status === "UNVERIFIED" && check.verdict === "SUPPORTED" && check.evidenceKind === "ASSERTED_BY_PARTY"
          ? `Asserted by ${event.assertedBy ?? "one party"} only; nothing else in the record confirms or contradicts it.`
          : status === "UNVERIFIED" && check.verdict === "SUPPORTED" && check.evidenceKind === "STATED_BY_WITNESS"
            ? `Stated by ${event.assertedBy ?? "a witness"} only; no other document in the record confirms it.`
            : check.notes,
    ...(sweep.corroboratedBy.length ? { corroboratedBy: sweep.corroboratedBy } : {}),
    ...(sweep.contradictedBy.length ? { contradictedBy: sweep.contradictedBy.map((c) => c.docId) } : {}),
  };
}

/** "Its own source states this, but X contradicts it" — the two halves are both true, and saying
 * only one (or the two run together) reads as the note contradicting itself. */
function conflictNote(conflicts: { docId: string; confidence: number }[], own: AssertionCheck, ctx: AssessContext): string {
  const name = (id: string) => ctx.docNames?.get(id) ?? id;
  const [first, ...rest] = conflicts;
  const others = rest.length ? ` and ${rest.length} other ${rest.length === 1 ? "document" : "documents"}` : "";
  const ownPart = own.confidence >= SUPPORT_MIN_CONFIDENCE ? `Its own source states this (confidence ${Math.round(own.confidence * 100)}%), but ` : "";
  return `${ownPart}${name(first.docId)}${others} ${rest.length ? "contradict" : "contradicts"} it (confidence ${Math.round(first.confidence * 100)}%).`;
}

/**
 * Whose account it is decides whether the rest of the case matters. A document that simply is the
 * event (an email, a docket stamp) needs no second opinion; a party's assertion, a witness's
 * recollection, or anything the generator attributed to someone ("assertedBy") does — and a
 * contradiction elsewhere must be able to overturn even a "Verified"-looking claim by a party.
 */
function needsSweep(event: ReconstructionEvent, check: AssertionCheck): boolean {
  if (!event.date || check.verdict !== "SUPPORTED") return false;
  return check.evidenceKind === "ASSERTED_BY_PARTY" || check.evidenceKind === "STATED_BY_WITNESS" || !!event.assertedBy;
}

async function sweepOtherDocuments(
  event: ReconstructionEvent,
  sourceDocId: string,
  ctx: AssessContext,
  deps: AssessDeps,
): Promise<{ corroboratedBy: string[]; contradictedBy: { docId: string; confidence: number }[] }> {
  const eventWords = contentWords(event.proposition);
  const candidates = findCorroborationCandidates(
    { eventDate: event.date!, proposition: event.proposition, sourceDocumentId: sourceDocId },
    ctx.facts,
    { minOverlap: 0, minSharedWords: 0 },
  )
    .map((c) => {
      // A sentence trimmed by bundle-facts ("…") can't be located in the document, so read it as is.
      const text = ctx.fullTextByDocId.get(c.fact.documentId) ?? "";
      const passage = c.fact.sentence.includes("…") ? c.fact.sentence : passageAround(text, c.fact.sentence);
      const { shared, overlap } = overlapOf(eventWords, contentWords(passage));
      return { fact: c.fact, passage, overlap, shared };
    })
    .sort((a, b) => b.overlap - a.overlap || b.shared - a.shared)
    .slice(0, MAX_SWEEP_DOCUMENTS);

  const results = await Promise.all(
    candidates.map(async (c) => {
      try {
        const check = await deps.checkAssertion(event.proposition, c.passage, c.fact.documentId);
        return { docId: c.fact.documentId, check, passage: c.passage };
      } catch {
        return null; // An unchecked document is neither corroboration nor contradiction.
      }
    }),
  );

  const corroboratedBy: string[] = [];
  const contradictedBy: { docId: string; confidence: number }[] = [];
  for (const r of results) {
    if (!r) continue;
    if (r.check.verdict === "CONTRADICTED") contradictedBy.push({ docId: r.docId, confidence: r.check.confidence });
    else if (isCorroboratingCheck(r.check, r.passage)) corroboratedBy.push(r.docId);
  }
  return { corroboratedBy, contradictedBy };
}

export async function assessEvents(events: ReconstructionEvent[], ctx: AssessContext, deps: AssessDeps): Promise<ReconstructionEvent[]> {
  const out: ReconstructionEvent[] = [];
  for (let i = 0; i < events.length; i += CONCURRENCY) {
    out.push(...(await Promise.all(events.slice(i, i + CONCURRENCY).map((e) => assessEvent(e, ctx, deps)))));
  }
  return out;
}
