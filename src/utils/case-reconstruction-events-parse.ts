import { parseAiJson } from "./response-parser";
import { stripChatWonderNoise } from "./chat-wonder-noise";
import type { EventStatus } from "./reconstruction-event-status";

const MAX_EVENTS = 40;
const MAX_TEXT_CHARS = 300;
const MAX_QUOTE_CHARS = 300;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface EventSourceRef {
  docId: string;
  page: number | null;
  quote: string;
}

/** One dated event of the case, stated as a fact and backed by at most one source quote. The
 * status fields are filled in later by the service (Jev check + corroboration), never by the
 * model that wrote the event. */
export interface ReconstructionEvent {
  index: number;
  /** YYYY-MM-DD, or null when the documents give no usable date. */
  date: string | null;
  /** The event as a factual proposition ("Doe was absent from 4 August"), never as an
   * allegation ("abandonment alleged to begin") — a claim about a claim cannot be checked against
   * the underlying record (benchmarks/reconstruction, case E11). */
  proposition: string;
  /** Who says so, as the source presents it: "Acme HR, termination letter". */
  assertedBy: string | null;
  /** Null when the model's quote could not be found in the named document; such an event can
   * never be Verified. */
  sourceRef: EventSourceRef | null;
  status?: EventStatus;
  statusConfidence?: number;
  statusNote?: string;
  /** Documents that independently show the event (see reconstruction-corroboration.ts). */
  corroboratedBy?: string[];
  /** Documents that say the opposite (see reconstruction-event-assess.ts); the event is Disputed. */
  contradictedBy?: string[];
}

export type RawEvent = Omit<ReconstructionEvent, "sourceRef" | "index"> & { rawSourceRef: { docId?: unknown; page?: unknown; quote?: unknown } };

function trimmedString(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim().slice(0, maxLen);
  return trimmed || undefined;
}

function validIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = value.trim().match(ISO_DATE_RE);
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? value.trim() : null;
}

/** Extracts and shape-validates the [EVENTS] block. `undefined` = the tag is missing or
 * unparseable, which the service treats as "chat-wonder returned nothing usable" rather than
 * persisting an empty chain. Quote checking is auditEvents' job. */
export function parseRawEvents(text: string): RawEvent[] | undefined {
  const cleaned = stripChatWonderNoise(text);
  const closed = cleaned.match(/\[EVENTS\]([\s\S]*?)\[\/EVENTS\]/i);
  const tagContent = closed ? closed[1] : cleaned.match(/\[EVENTS\]([\s\S]*?)(?:\[(?:\/)?[A-Z_]+\]|$)/i)?.[1];
  if (!tagContent) return undefined;

  const jsonStr = tagContent.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const parsed = parseAiJson(jsonStr);
  if (!Array.isArray(parsed)) return undefined;

  const events: RawEvent[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const proposition = trimmedString(r.proposition, MAX_TEXT_CHARS);
    if (!proposition) continue; // nothing to check or render
    events.push({
      date: validIsoDate(r.date),
      proposition,
      assertedBy: trimmedString(r.assertedBy, 160) ?? null,
      rawSourceRef: { docId: r.docId, page: r.page, quote: r.quote },
    });
    if (events.length >= MAX_EVENTS) break;
  }
  return events.length > 0 ? events : undefined;
}

function normaliseForMatch(text: string): string {
  return text.replace(/\s+/g, " ").toLowerCase();
}

/** Where a quote sits in a document's text, matching across whitespace and case differences that
 * PDF extraction introduces. -1 when it is not there. */
export function locateQuote(corpus: string, quote: string): number {
  return normaliseForMatch(corpus).indexOf(normaliseForMatch(quote));
}

export interface AuditedEvents {
  events: ReconstructionEvent[];
  /** Every source the audit threw away, with why — see diagnoseDroppedQuote. Empty when all held. */
  dropped: DroppedQuote[];
}

/**
 * Keeps the source only if its docId is a real, indexed case document and its quote is actually in
 * that document — unlike scenes, a quote is REQUIRED (an event with nothing to check it against
 * cannot be Verified, so it keeps its place in the chain with `sourceRef: null` and lands as
 * Unverified). Orders the chain by date, undated events last, and numbers it. `dropped` says what
 * was thrown away and why, so a run that loses true events' sources can be understood.
 */
export function auditEventsDetailed(rawEvents: RawEvent[], readyDocIds: Set<string>, corpusByDocId: Map<string, string>): AuditedEvents {
  const dropped: DroppedQuote[] = [];
  const audited = rawEvents.map((raw) => {
    const { rawSourceRef, ...rest } = raw;
    const docId = trimmedString(rawSourceRef.docId, 100);
    const quote = trimmedString(rawSourceRef.quote, MAX_QUOTE_CHARS);
    let sourceRef: EventSourceRef | null = null;
    if (docId && quote && readyDocIds.has(docId) && locateQuote(corpusByDocId.get(docId) ?? "", quote) >= 0) {
      sourceRef = { docId, page: typeof rawSourceRef.page === "number" ? rawSourceRef.page : null, quote };
    } else {
      dropped.push({ ...diagnoseDroppedQuote(docId, quote, readyDocIds, corpusByDocId), date: rest.date, proposition: rest.proposition });
    }
    return { ...rest, sourceRef };
  });
  // The same fact restated (two documents recording it, or the model repeating itself) is one event:
  // same date and same wording once case, punctuation and spacing are gone. The first is kept.
  const seen = new Set<string>();
  const unique = audited.filter((e) => {
    const key = `${e.date ?? ""}|${e.proposition.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => (a.date ?? "9999-99-99").localeCompare(b.date ?? "9999-99-99"));
  return { events: unique.map((e, index) => ({ index, ...e })), dropped };
}

export function auditEvents(rawEvents: RawEvent[], readyDocIds: Set<string>, corpusByDocId: Map<string, string>): ReconstructionEvent[] {
  return auditEventsDetailed(rawEvents, readyDocIds, corpusByDocId).events;
}

// ── Why a quote failed ────────────────────────────────────────────────────────────────────────────

/**
 * COSMETIC        the quote is in the named document once punctuation and spacing are ignored entirely
 *                 (a dash, a curly quote, a wrapped line) — broadening normalisation would rescue it
 * WRONG_DOCUMENT  it is verbatim in a different ready document — the model named the wrong one
 * PARAPHRASE      it is nowhere; the model reworded the text (closest stretch and word diff attached)
 * NO_QUOTE        the model gave none
 * UNKNOWN_DOCUMENT it named a document that is not one of the case's indexed documents
 */
export type DroppedQuoteKind = "COSMETIC" | "WRONG_DOCUMENT" | "PARAPHRASE" | "NO_QUOTE" | "UNKNOWN_DOCUMENT";

export interface DroppedQuote {
  kind: DroppedQuoteKind;
  docId: string | null;
  quote: string | null;
  /** WRONG_DOCUMENT: the documents that do contain it. */
  foundIn?: string[];
  /** PARAPHRASE: the stretch of the named document that shares the most words with the quote. */
  closest?: { docId: string; snippet: string; matched: number; total: number; missing: string[]; extra: string[] };
  date?: string | null;
  proposition?: string;
}

const SNIPPET_WORDS_MAX = 40;
const DIFF_WORDS_MAX = 8;

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function squashed(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** The window of `corpus` (as many words as the quote has, at least 5) that shares the most of the
 * quote's distinct words — linear in the document, so cheap enough to run for every dropped quote. */
export function closestWindow(corpus: string, quote: string): { snippet: string; matched: number; total: number; missing: string[]; extra: string[] } | null {
  const q = words(quote);
  const doc = words(corpus);
  if (!q.length || !doc.length) return null;
  const qSet = new Set(q);
  const size = Math.min(doc.length, Math.max(q.length, 5));
  const inQuote = doc.map((w) => (qSet.has(w) ? 1 : 0));
  let score = 0;
  for (let i = 0; i < size; i++) score += inQuote[i];
  let best = { start: 0, score };
  for (let i = size; i < doc.length; i++) {
    score += inQuote[i] - inQuote[i - size];
    if (score > best.score) best = { start: i - size + 1, score };
  }
  const window = doc.slice(best.start, best.start + size);
  const wSet = new Set(window);
  return {
    snippet: window.slice(0, SNIPPET_WORDS_MAX).join(" "),
    matched: best.score,
    total: size,
    missing: [...qSet].filter((w) => !wSet.has(w)).slice(0, DIFF_WORDS_MAX),
    extra: [...wSet].filter((w) => !qSet.has(w)).slice(0, DIFF_WORDS_MAX),
  };
}

export function diagnoseDroppedQuote(
  docId: string | undefined,
  quote: string | undefined,
  readyDocIds: Set<string>,
  corpusByDocId: Map<string, string>,
): DroppedQuote {
  const base = { docId: docId ?? null, quote: quote ?? null };
  if (!quote) return { ...base, kind: "NO_QUOTE" };
  if (!docId || !readyDocIds.has(docId)) return { ...base, kind: "UNKNOWN_DOCUMENT" };

  const named = corpusByDocId.get(docId) ?? "";
  const q = squashed(quote);
  if (q && squashed(named).includes(q)) return { ...base, kind: "COSMETIC" };

  const foundIn = [...readyDocIds].filter((id) => id !== docId && locateQuote(corpusByDocId.get(id) ?? "", quote) >= 0);
  if (foundIn.length) return { ...base, kind: "WRONG_DOCUMENT", foundIn };

  const closest = closestWindow(named, quote);
  return { ...base, kind: "PARAPHRASE", ...(closest ? { closest: { docId, ...closest } } : {}) };
}

/** Counts by kind, for the one-line summary of a run. */
export function summariseDrops(dropped: DroppedQuote[]): Record<string, number> {
  return dropped.reduce<Record<string, number>>((n, d) => ((n[d.kind] = (n[d.kind] ?? 0) + 1), n), {});
}

/** The stretch of a document around an event's quote — what Jev reads the proposition against.
 * Centred on the quote so the surrounding sentences that qualify it come along. */
export function passageAround(corpus: string, quote: string, budget = 1500): string {
  const at = locateQuote(corpus, quote);
  const flat = corpus.replace(/\s+/g, " ");
  if (at < 0) return flat.slice(0, budget);
  const start = Math.max(0, at - Math.floor((budget - quote.length) / 2));
  return flat.slice(start, start + budget);
}
