/**
 * Phase 1, step 1 of docs/plans/grounding-verifier.md: pull the checkable claims out of a legal
 * answer and decide what the bundle says about them. Pure text work — no AI, no database, no
 * network — so it is cheap to run on every turn and cheap to test.
 *
 * Two kinds of claim matter, because criterion A of the Brackenmoor rubric ("Grounding & citation
 * discipline", 25 marks, scored 3–15 across twelve gradings) is lost to exactly these:
 *
 *   1. ABSENCE — the answer says bundle material was unavailable to it. Sometimes true for the
 *      turn, sometimes flatly false; classifyAbsence separates those, which is the whole point.
 *   2. ASSERTION — the answer states a fact and pins it to a document. Whether the cited passage
 *      actually supports it is a Jev question (step 3); finding the pairs is this module's job.
 */

/** A bundle reference as the answer wrote it: "D06 paras 1–2", "D20.1 para. 7", "D10 item 10.6". */
export interface CitationRef {
  /** Exactly as it appeared, for display and for storing next to a verdict. */
  raw: string;
  /** "D06" — the bundle document label, always two digits so D5 and D05 can't diverge. */
  document: string;
  /** The sub-document, where one is cited: "1" from "D20.1" (the peer-review exhibit). */
  part?: string;
  /** "paras 1–2", "Part 3", "item 10.6" — kept verbatim; resolving it to a passage is step 3's
   * problem and depends on how the document was uploaded. */
  locator?: string;
  /** Character offset in the answer, so a verdict can be anchored back to the text. */
  index: number;
}

/**
 * D-number, optional ".n" sub-document, optional locator. The locator alternatives are the forms
 * the graded answers actually used — "Part"/"Parts", "para"/"paras" with or without the full
 * stop, "s."/"ss." for sections, "item"/"items" — followed by a number that may carry decimals
 * ("item 10.6") and may be a range or list ("paras 10–14", "Parts 1 and 2").
 */
const CITATION_RE =
  /\bD(\d{1,2})(?:\.(\d+))?(?:[,\s]+(Parts?|paras?\.?|pp?\.|ss?\.|items?|sections?|clauses?)\s*(\d+(?:\.\d+)*(?:\s*(?:–|—|-|to|and|,)\s*\d+(?:\.\d+)*)*))?/gi;

export function parseCitations(text: string): CitationRef[] {
  const out: CitationRef[] = [];
  if (!text) return out;
  for (const m of text.matchAll(CITATION_RE)) {
    out.push({
      raw: m[0].trim(),
      document: `D${m[1].padStart(2, "0")}`,
      part: m[2],
      locator: m[3] ? `${m[3]} ${m[4]}`.replace(/\s+/g, " ").trim() : undefined,
      index: m.index ?? 0,
    });
  }
  return out;
}

/** Abbreviations that end in a full stop mid-sentence — splitting after them would cut a citation
 * ("D01 para. 13") in half and orphan the locator from its document. */
const ABBREVIATIONS = ["para", "paras", "pp", "p", "s", "ss", "no", "nos", "pt", "cl", "r", "art", "v", "ltd", "co", "approx", "e.g", "i.e", "cf", "sched", "sch"];

/** Leading markdown furniture on a line: "- ", "* ", "1. ", "#### ", "> ", and the bold/italic
 * runs the answers wrap document labels in ("- **D15 Parts 1–4**: contract terms…"). */
function stripMarkdown(line: string): string {
  return line
    .replace(/^\s{0,8}(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\s{0,8}#{1,6}\s+/, "")
    .replace(/^\s{0,8}>\s?/, "")
    .replace(/\*\*|__|`/g, "")
    .trim();
}

/**
 * Sentence split that survives legal citation punctuation. Deliberately conservative: it would
 * rather return one long sentence than sever an assertion from the reference that grounds it.
 *
 * Splits on newlines first. These answers are markdown — headings and bullet items are semantic
 * units that frequently carry no full stop, so splitting on sentence punctuation alone welded
 * whole sections into one pseudo-sentence, which in turn hid the absence disclaimers inside them.
 */
export function splitSentences(text: string): { sentence: string; index: number }[] {
  const out: { sentence: string; index: number }[] = [];
  if (!text) return out;
  let offset = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const lineStart = text.indexOf(rawLine, offset);
    offset = lineStart + rawLine.length;
    const line = stripMarkdown(rawLine);
    if (!line) continue;
    for (const piece of splitLine(line)) out.push({ sentence: piece.sentence, index: lineStart + piece.index });
  }
  return out;
}

function splitLine(text: string): { sentence: string; index: number }[] {
  const out: { sentence: string; index: number }[] = [];
  const parts = text.split(/(?<=[.?!;])\s+/);
  let cursor = 0;
  let buffer = "";
  let bufferStart = 0;
  for (const part of parts) {
    const start = text.indexOf(part, cursor);
    cursor = start + part.length;
    if (!buffer) bufferStart = start;
    buffer = buffer ? `${buffer} ${part}` : part;
    const tail = buffer.trimEnd();
    const lastWord = tail.slice(0, -1).split(/[\s(]/).pop()?.toLowerCase() ?? "";
    const endsOnAbbreviation = tail.endsWith(".") && ABBREVIATIONS.includes(lastWord);
    // "…(D01 para." — an unclosed bracket means the reference continues into the next fragment.
    const unclosedBracket = (buffer.match(/\(/g)?.length ?? 0) > (buffer.match(/\)/g)?.length ?? 0);
    if (endsOnAbbreviation || unclosedBracket) continue;
    const trimmed = buffer.trim();
    if (trimmed) out.push({ sentence: trimmed, index: bufferStart });
    buffer = "";
  }
  const trailing = buffer.trim();
  if (trailing) out.push({ sentence: trailing, index: bufferStart });
  return out;
}

/**
 * Phrases in which the answer says material was unavailable TO IT. Each one names the supplied
 * material ("the available extract", "the material presently available", "the supplied case
 * context") or the assistant's own sight of it ("not before me", "I cannot see").
 *
 * A bare "not supplied" is deliberately absent: the graded answers contain "Obtain all
 * photographs not supplied to Dr Vantrease", which is a direction about a third party's disclosure
 * and has nothing to do with what the assistant was given. Matching it would manufacture a
 * grounding defect out of a correct sentence.
 */
/** "not reproduced", "not been reproduced", "not yet been set out" — the auxiliary between the
 * negation and the participle is optional and varies, and leaving it out of the patterns silently
 * dropped real disclaimers. */
const NOT_VERB = String.raw`not (?:yet )?(?:been |being )?(?:reproduced|included|set out|contained|visible|present|provided|supplied)`;

const ABSENCE_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\b${NOT_VERB}\b[^.;]{0,60}\b(?:available|supplied|provided|present)\b`, "i"),
  // "…is not reproduced here" / "have not been reproduced in full" — the disclaimer with no noun
  // for the supplied material at all. Anchored tightly so it cannot swallow "not provided to the
  // defence", which is about a party's disclosure rather than our own sight of the document.
  new RegExp(String.raw`\b${NOT_VERB} (?:here|in full|in the answer|above|below)\b`, "i"),
  // "none is reproduced in the material provided" — negation carried by "none" rather than "not".
  /\bnone (?:is|are|was|were) (?:reproduced|included|set out|provided|supplied|available)\b/i,
  // Plurals matter: the answers write "the visible extracts" and "the available extracts" as often
  // as the singular, and a missing "s" silently halved absence recall on the real answers.
  new RegExp(String.raw`\b${NOT_VERB}\b[^.;]{0,40}\b(?:extracts?|bundles?|materials?|contexts?|records?)\b`, "i"),
  // The inverted form, where the supplied material is the subject rather than the object: "the
  // available material does not set out…", "the present extracts do not provide…". The subject
  // list is deliberately restricted to words for what WE were given — widen it to a party name
  // and "Meridian has not provided a disclosure protocol" becomes a false grounding defect.
  /\b(?:extracts?|bundles?|materials?|records?|case context|supplied documents?)\b[^.;]{0,30}\b(?:does|do|did) not (?:set out|contain|include|reproduce|show|provide|state|give)\b/i,
  /\bnot (?:available|provided|supplied|disclosed) to (?:me|us)\b/i,
  /\bnot before (?:me|us)\b/i,
  /\b(?:I|we) (?:cannot|could not|can't|am unable to|are unable to) (?:see|read|locate|access|find)\b/i,
  /\b(?:I|we) (?:do|did) not have\b[^.;]{0,40}\b(?:document|text|extract|material|paragraph|copy)\b/i,
  /\bno (?:copy|text|version|extract) of\b[^.;]{0,40}\b(?:is|was) (?:available|provided|supplied)\b/i,
  /\b(?:document|text|paragraph|section|extract) (?:is|was) not (?:available|provided|supplied)\b/i,
];

export interface AbsenceClaim {
  sentence: string;
  /** References inside the sentence. Empty when the answer disclaimed material without naming it —
   * still worth recording, but unresolvable, so it scores UNRESOLVED. */
  citations: CitationRef[];
  index: number;
}

export function parseAbsenceClaims(text: string): AbsenceClaim[] {
  return splitSentences(text)
    .filter(({ sentence }) => ABSENCE_PATTERNS.some((re) => re.test(sentence)))
    .map(({ sentence, index }) => ({ sentence, citations: parseCitations(sentence), index }));
}

export interface CitedAssertion {
  /** The sentence with its bracketed references removed, so what gets checked reads as a claim
   * rather than as prose with footnotes in it. */
  assertion: string;
  citations: CitationRef[];
  index: number;
}

/**
 * Sentences that state something and pin it to the bundle. Sentences that merely list references
 * ("The evidential basis for those matters comes from D01, D06, D08, D11, D12, D14, D19 and
 * D20.1.") carry no checkable proposition, so they are dropped: asking Jev whether a passage
 * supports a list of document names would burn a call to learn nothing.
 */
export function parseCitedAssertions(text: string): CitedAssertion[] {
  const out: CitedAssertion[] = [];
  for (const { sentence, index } of splitSentences(text)) {
    const citations = parseCitations(sentence);
    if (!citations.length) continue;
    const assertion = sentence
      .replace(/\(([^)]*)\)/g, (whole, inner: string) => (/\bD\d{1,2}\b/.test(inner) ? "" : whole))
      .replace(CITATION_RE, "")
      .replace(/\s{2,}/g, " ")
      .replace(/\s+([,.;])/g, "$1")
      // A list item labels itself with the reference ("D15 Parts 1–4: contract terms, IA 18…"),
      // so removing the reference leaves the separator stranded at the front. Without this the
      // stored assertion reads "- : contract terms…" and means nothing to whoever audits it.
      .replace(/^[\s,;:—–-]+/, "")
      .replace(/[\s,;]+$/, "")
      .trim();
    // A reference list ("…comes from D01, D06, D08 and D20.1.") differs from an assertion not in
    // length but grammatically: the references ARE the object, so stripping them leaves a dangling
    // preposition or conjunction. An assertion keeps its references in brackets, and removing them
    // leaves a complete clause. Length alone kept the list sentences, which then burned a Jev call
    // asking whether a passage supports a list of document names.
    if (/\b(from|in|at|of|and|to|with|by|see|under|per)\s*[.;,]?$/i.test(assertion)) continue;
    if (assertion.replace(/[^a-z]/gi, "").length < 25) continue;
    out.push({ assertion, citations, index });
  }
  return out;
}

/**
 * What the case holds and what this turn actually sent, as the worker knows it. `inCase` maps a
 * bundle label to the Document id backing it; `supplied` is the subset whose text genuinely
 * reached chat-wonder (inlined whole, or as a ranked chunk).
 */
export interface BundleView {
  inCase: Record<string, string>;
  supplied: Set<string>;
}

/**
 * Bundle labels a stored document provides. A file named "D14_Site_Daily_Log.pdf" provides D14;
 * a merged upload named "D01-D20_All.pdf" provides every label in the range, because the whole
 * bundle is in there — but only at document level, since there is no per-exhibit boundary to
 * resolve a locator against. That is the merged-bundle limitation called out in the plan, made
 * explicit here rather than left to surprise the caller.
 */
export function documentLabelsFor(fileName: string): string[] {
  // \b does not fire between a digit and "_", which is exactly how these files are named
  // ("D14_Site_Daily_Log.pdf", "D01-D20_All.pdf"), so the boundary is spelled out as "no further
  // digit" rather than left to \b.
  const range = fileName.match(/\bD(\d{1,2})\s*[-–—]\s*D?(\d{1,2})(?!\d)/i);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (to >= from && to - from <= 99) {
      return Array.from({ length: to - from + 1 }, (_, i) => `D${String(from + i).padStart(2, "0")}`);
    }
  }
  return [...fileName.matchAll(/\bD(\d{1,2})(?!\d)/gi)].map((m) => `D${m[1].padStart(2, "0")}`);
}

export function buildBundleView(
  documents: { id: string; name: string }[],
  suppliedDocumentIds: Iterable<string>,
): BundleView {
  const inCase: Record<string, string> = {};
  const byId: Record<string, string[]> = {};
  for (const doc of documents) {
    const labels = documentLabelsFor(doc.name);
    byId[doc.id] = labels;
    for (const label of labels) if (!(label in inCase)) inCase[label] = doc.id;
  }
  const supplied = new Set<string>();
  for (const id of suppliedDocumentIds) for (const label of byId[id] ?? []) supplied.add(label);
  return { inCase, supplied };
}

export type AbsenceVerdict = "FALSE_ABSENCE" | "NOT_SUPPLIED" | "CORRECT_ABSENCE" | "UNRESOLVED";

/**
 * The three-way split the plan turns on:
 *
 *   FALSE_ABSENCE   — the document is in the case AND its text was sent this turn. The model had
 *                     it and said it didn't. A real grounding defect.
 *   NOT_SUPPLIED    — in the case, but its text never reached the model (over the inline cap, not
 *                     among the ranked chunks, never fetched via get_case_document). The answer is
 *                     honest about what it saw and wrongly worded about the bundle; the defect
 *                     belongs to the pipeline, not the model.
 *   CORRECT_ABSENCE — not in the case at all. The answer is right, and this is a determinative
 *                     silence worth surfacing (criterion F).
 *   UNRESOLVED      — the answer disclaimed material without naming it, or named something this
 *                     parser could not resolve. Counted, never guessed at.
 *
 * Collapsing NOT_SUPPLIED into FALSE_ABSENCE is the trap: on the 21 September runs the inline cap
 * was 40k against a ~164k bundle, so most disclaimers were true for the turn. Scoring those as
 * hallucinations would have blamed the model for a configuration choice.
 */
export function classifyAbsence(claim: AbsenceClaim, view: BundleView): { verdict: AbsenceVerdict; document?: string; documentId?: string } {
  if (!claim.citations.length) return { verdict: "UNRESOLVED" };
  // Worst case wins: one demonstrably false disclaimer in a sentence makes the sentence false,
  // however many other documents it names.
  const ranked: AbsenceVerdict[] = ["FALSE_ABSENCE", "NOT_SUPPLIED", "CORRECT_ABSENCE"];
  let best: { verdict: AbsenceVerdict; document?: string; documentId?: string } | undefined;
  for (const citation of claim.citations) {
    const documentId = view.inCase[citation.document];
    const verdict: AbsenceVerdict = !documentId
      ? "CORRECT_ABSENCE"
      : view.supplied.has(citation.document)
        ? "FALSE_ABSENCE"
        : "NOT_SUPPLIED";
    const candidate = { verdict, document: citation.document, documentId };
    if (!best || ranked.indexOf(verdict) < ranked.indexOf(best.verdict)) best = candidate;
  }
  return best ?? { verdict: "UNRESOLVED" };
}

/** Everything step 1 can say about one answer without calling anything. */
export interface GroundingScan {
  absenceClaims: (AbsenceClaim & { verdict: AbsenceVerdict; document?: string; documentId?: string })[];
  assertions: CitedAssertion[];
  counts: Record<AbsenceVerdict, number> & { assertions: number; citations: number };
}

export function scanAnswer(text: string, view: BundleView): GroundingScan {
  const absenceClaims = parseAbsenceClaims(text).map((claim) => ({ ...claim, ...classifyAbsence(claim, view) }));
  const assertions = parseCitedAssertions(text);
  const counts = {
    FALSE_ABSENCE: 0,
    NOT_SUPPLIED: 0,
    CORRECT_ABSENCE: 0,
    UNRESOLVED: 0,
    assertions: assertions.length,
    citations: parseCitations(text).length,
  };
  for (const claim of absenceClaims) counts[claim.verdict]++;
  return { absenceClaims, assertions, counts };
}
