/**
 * Pass 1 of the full-bundle contradiction scan (full-contradiction-scan.service.ts): every date,
 * amount and duration in every chunk of a document, each tagged with where it sits — exhibit and
 * page — so a contradiction found later can say "D13 p.2 vs D18 p.1" rather than just naming the
 * one merged PDF both sides came from. Pure and deterministic: no AI, no database.
 *
 * Wider than fact-extract.ts (the older document-vs-document regex scan), which only knows
 * month-first dates, ISO dates and peso amounts: the Brackenmoor-style UK bundle this was built
 * against writes "14 November 2023", "16.11.2023", "£4,500" and "eleven days" — none of which that
 * extractor matches.
 */

export type BundleFactKind = "date" | "amount" | "duration";

export interface BundleChunk {
  id: string;
  caseDocumentId: string;
  chunkIndex: number;
  pageNumber: number | null;
  chunkText: string;
}

export interface BundleFact {
  chunkId: string;
  documentId: string;
  pageNumber: number | null;
  /** e.g. "D13", "Exhibit B" — null when the document has no exhibit markers. */
  exhibit: string | null;
  /** Human-readable position: "D13 p.2", "D13", or "p.31". */
  locator: string | null;
  kind: BundleFactKind;
  /** Normalized for comparison: YYYY-MM-DD, "GBP4500.00", "11d". */
  value: string;
  /** As written in the document. */
  display: string;
  /** The sentence around the value — what Jev and the lawyer read. */
  sentence: string;
  /** Date written without a year ("on 14 November"); the year was taken from the nearest earlier
   * full date in the same exhibit. */
  yearInferred: boolean;
}

export interface BundleFactOptions {
  /** How to read 03/04/2024: true = 3 April (UK), false = March 4 (PH/US). Dotted dates
   * (03.04.2024) are always day-first. */
  numericDayFirst: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_NAMES = "January|February|March|April|May|June|July|August|September|October|November|December";
const MONTH_ANY = `(?:${MONTH_NAMES}|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\\.?`;

const DAY_FIRST_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_ANY}),?\\s+(\\d{4})\\b`, "gi");
const MONTH_FIRST_RE = new RegExp(`\\b(${MONTH_ANY})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi");
// Full month names only — "3 May" alone is too often not a date ("3 may apply").
const DAY_FIRST_NO_YEAR_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\b(?!,?\\s+\\d{4})`, "g");
const ISO_RE = /\b(19\d{2}|20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/g;
const DOTTED_RE = /\b(\d{1,2})\.(\d{1,2})\.(19\d{2}|20\d{2})\b/g;
const SLASH_RE = /\b(\d{1,2})\/(\d{1,2})\/(19\d{2}|20\d{2})\b/g;
const AMOUNT_RE = /(£|€|\$|₱|\b(?:GBP|USD|EUR|PHP|Php)\b)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?:\s?(k|m|million|thousand)\b)?/g;
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
};
const DURATION_RE = new RegExp(`\\b(\\d{1,3}|${Object.keys(NUMBER_WORDS).join("|")})\\s+(day|week|month|year)s?\\b`, "gi");
const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };

// Exhibit markers, strongest first. A bundle cover line and a "D13 / p.2" footer both name the
// exhibit; only the footer also gives the page within it.
const COVER_RE = /BUNDLE DOCUMENT\s+(\d{1,3})\s+OF\s+\d{1,3}/i;
const FOOTER_RE = /\b(D\d{1,3})\s*\/\s*p\.?\s*(\d{1,3})\b/;
// The label must look like one ("A", "B-2", "12", "JR1") — not a word, so "Exhibit Bundle" or
// "Annex to the report" never becomes an exhibit.
const EXHIBIT_HEADING_RE = /(?:^|\n)\s*((?:EXHIBIT|ANNEX(?:URE)?|TAB)\s+(?:[A-Z]{1,3}-?\d{1,3}|[A-Z]|\d{1,3}))\b/i;

const CURRENCY: Record<string, string> = { "£": "GBP", "€": "EUR", $: "USD", "₱": "PHP", GBP: "GBP", USD: "USD", EUR: "EUR", PHP: "PHP", Php: "PHP" };

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1) return null; // 31 February etc.
  return `${year}-${pad(month)}-${pad(day)}`;
}

function monthOf(name: string): number {
  return MONTHS[name.toLowerCase().replace(/\.$/, "").slice(0, 3)] ?? 0;
}

/** The sentence containing [start, end), trimmed to the chunk and to ~300 characters. */
function sentenceAround(text: string, start: number, end: number): string {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const sStart = Math.max(before.lastIndexOf(". "), before.lastIndexOf("\n"), before.lastIndexOf("? "), before.lastIndexOf("! "));
  const tail = after.search(/[.?!](\s|$)|\n/);
  const from = sStart >= 0 ? sStart + 1 : 0;
  const to = tail >= 0 ? end + tail + 1 : text.length;
  let sentence = text.slice(from, to).replace(/\s+/g, " ").trim();
  if (sentence.length > 300) {
    const mid = Math.max(0, start - from - 140);
    sentence = `…${sentence.slice(mid, mid + 280).trim()}…`;
  }
  return sentence;
}

interface Match {
  kind: BundleFactKind;
  value: string;
  display: string;
  start: number;
  end: number;
  yearInferred: boolean;
}

function datesIn(text: string, opts: BundleFactOptions, contextYear: number | null): { matches: Match[]; lastYear: number | null } {
  const matches: Match[] = [];
  const taken: [number, number][] = [];
  let lastYear = contextYear;
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);
  const add = (value: string | null, m: RegExpMatchArray, yearInferred = false) => {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (!value || overlaps(start, end)) return;
    taken.push([start, end]);
    matches.push({ kind: "date", value, display: m[0], start, end, yearInferred });
  };

  const full: { m: RegExpMatchArray; value: string | null; year: number }[] = [];
  for (const m of text.matchAll(DAY_FIRST_RE)) full.push({ m, value: isoDate(+m[3], monthOf(m[2]), +m[1]), year: +m[3] });
  for (const m of text.matchAll(MONTH_FIRST_RE)) full.push({ m, value: isoDate(+m[3], monthOf(m[1]), +m[2]), year: +m[3] });
  for (const m of text.matchAll(ISO_RE)) full.push({ m, value: isoDate(+m[1], +m[2], +m[3]), year: +m[1] });
  for (const m of text.matchAll(DOTTED_RE)) full.push({ m, value: isoDate(+m[3], +m[2], +m[1]), year: +m[3] });
  for (const m of text.matchAll(SLASH_RE)) {
    const [a, b] = [+m[1], +m[2]];
    full.push({ m, value: opts.numericDayFirst ? isoDate(+m[3], b, a) : isoDate(+m[3], a, b), year: +m[3] });
  }
  full.sort((x, y) => (x.m.index ?? 0) - (y.m.index ?? 0));
  for (const f of full) add(f.value, f.m);

  // Year-less dates take the year of the nearest full date before them — in this chunk if there
  // is one, else carried in from earlier chunks of the same exhibit.
  const yearAt = (pos: number) => {
    const before = full.filter((f) => f.value && (f.m.index ?? 0) < pos);
    return before.length ? before[before.length - 1].year : contextYear;
  };
  for (const m of text.matchAll(DAY_FIRST_NO_YEAR_RE)) {
    const year = yearAt(m.index ?? 0);
    if (year) add(isoDate(year, monthOf(m[2]), +m[1]), m, true);
  }
  const years = full.filter((f) => f.value).map((f) => f.year);
  if (years.length) lastYear = years[years.length - 1];
  return { matches, lastYear };
}

function amountsIn(text: string): Match[] {
  const out: Match[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const currency = CURRENCY[m[1]] ?? m[1];
    let n = Number(`${m[2].replace(/,/g, "")}.${m[3] ?? "0"}`);
    const mult = (m[4] ?? "").toLowerCase();
    if (mult === "k" || mult === "thousand") n *= 1_000;
    if (mult === "m" || mult === "million") n *= 1_000_000;
    if (!Number.isFinite(n) || n === 0) continue;
    const start = m.index ?? 0;
    out.push({ kind: "amount", value: `${currency}${n.toFixed(2)}`, display: m[0].trim(), start, end: start + m[0].length, yearInferred: false });
  }
  return out;
}

function durationsIn(text: string): Match[] {
  const out: Match[] = [];
  for (const m of text.matchAll(DURATION_RE)) {
    const raw = m[1].toLowerCase();
    const n = NUMBER_WORDS[raw] ?? Number(raw);
    if (!Number.isFinite(n) || n === 0) continue;
    const start = m.index ?? 0;
    out.push({ kind: "duration", value: `${n * UNIT_DAYS[m[2].toLowerCase()]}d`, display: m[0], start, end: start + m[0].length, yearInferred: false });
  }
  return out;
}

/** Facts for one document's chunks, in chunk order (the order matters: exhibit markers and
 * year context carry forward from one chunk to the next). */
export function extractBundleFacts(chunks: BundleChunk[], opts: BundleFactOptions): BundleFact[] {
  const ordered = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const facts: BundleFact[] = [];
  let exhibit: string | null = null;
  // Last "Dnn / p.N" footer seen for the current exhibit, and the PDF page it was on — later
  // pages of the same exhibit count on from it.
  let anchor: { exhibitPage: number; pdfPage: number | null } | null = null;
  const yearByExhibit = new Map<string, number | null>();

  for (const chunk of ordered) {
    const text = chunk.chunkText;
    const cover = text.match(COVER_RE);
    const footer = text.match(FOOTER_RE);
    const heading = text.match(EXHIBIT_HEADING_RE);
    const next = footer?.[1] ?? (cover ? `D${pad(+cover[1])}` : null) ?? (heading ? heading[1].replace(/\s+/g, " ") : null);
    if (next && next !== exhibit) {
      exhibit = next;
      anchor = null;
    }
    if (footer) anchor = { exhibitPage: +footer[2], pdfPage: chunk.pageNumber };

    let exhibitPage: number | null = null;
    if (anchor) {
      exhibitPage =
        anchor.pdfPage != null && chunk.pageNumber != null ? anchor.exhibitPage + (chunk.pageNumber - anchor.pdfPage) : anchor.exhibitPage;
    }
    const locator = exhibit
      ? exhibitPage
        ? `${exhibit} p.${exhibitPage}`
        : exhibit
      : chunk.pageNumber != null
        ? `p.${chunk.pageNumber}`
        : null;

    const yearKey = exhibit ?? "";
    const { matches: dates, lastYear } = datesIn(text, opts, yearByExhibit.get(yearKey) ?? null);
    yearByExhibit.set(yearKey, lastYear);

    const seen = new Set<string>();
    for (const m of [...dates, ...amountsIn(text), ...durationsIn(text)]) {
      const key = `${m.kind}:${m.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push({
        chunkId: chunk.id,
        documentId: chunk.caseDocumentId,
        pageNumber: chunk.pageNumber,
        exhibit,
        locator,
        kind: m.kind,
        value: m.value,
        display: m.display,
        sentence: sentenceAround(text, m.start, m.end),
        yearInferred: m.yearInferred,
      });
    }
  }
  return facts;
}
