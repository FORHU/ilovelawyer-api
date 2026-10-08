import { choice } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import logger from "./logger";

export type CitationValidityStatus = "VALID" | "INVALID" | "UNVERIFIED" | "ADVERSE";

export interface CitationCheckInput {
  quotedText: string;
  officialText?: string | null;
  citedReference?: string | null;
}

export interface CitationCheckResult {
  status: CitationValidityStatus;
  notes: string;
  /** For a VALID decided by the heuristic: word for word ("exact"), or close but not word for word
   * ("fuzzy") — a fuzzy one still goes to Jev (see evaluateCitation). */
  match?: "exact" | "fuzzy";
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[“”"'’]/g, "")
    .trim();
}

/** Words, lowercased, without punctuation. Apostrophes are already gone (normalize), so
 * "don't" arrives as "dont". */
function tokens(text: string): string[] {
  return normalize(text)
    .split(" ")
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
}

/** Words that reverse what follows them. A quote that adds or drops one says something different,
 * so a near-match must have the same words negated as its source (#363). */
const NEGATIONS = new Set([
  "not", "no", "never", "nor", "neither", "none", "nothing", "nobody", "nowhere", "without", "unless",
  "cannot", "except", "dont", "doesnt", "didnt", "isnt", "arent", "wasnt", "werent", "wont", "wouldnt",
  "cant", "couldnt", "shouldnt", "mustnt", "neednt", "hasnt", "havent", "hadnt",
]);
/** How far back a negation reaches: "may not terminate", "has never committed", "without notice". */
const NEGATION_REACH = 3;

function isNegatedAt(words: string[], index: number): boolean {
  for (let i = Math.max(0, index - NEGATION_REACH); i < index; i++) {
    if (NEGATIONS.has(words[i])) return true;
  }
  return false;
}

export type QuoteMatch = "exact" | "fuzzy" | "none";

/**
 * Does the quote appear in the official text?
 * - "exact": word for word, after normalizing case, whitespace and quote marks.
 * - "fuzzy": nearly — at least 85% of the quote's content words fall in one stretch of the
 *   source about the quote's own length, and every one of them is negated (or not) the same way
 *   on both sides. Before #363 the words could be scattered anywhere in the source and "not"
 *   wasn't even counted, so a quote that reversed its source still matched.
 * - "none": otherwise.
 */
export function matchQuote(official: string, quote: string): QuoteMatch {
  const hay = normalize(official);
  const needle = normalize(quote);
  if (!needle) return "none";
  if (hay.includes(needle)) return "exact";
  if (needle.length < 12) return "none";

  const q = tokens(quote);
  const h = tokens(official);
  const content = q.map((word, index) => ({ word, index })).filter(({ word }) => word.length > 3 && !NEGATIONS.has(word));
  if (content.length < 4) return "none";

  const positions = new Map<string, number[]>();
  h.forEach((word, index) => {
    const list = positions.get(word);
    if (list) list.push(index);
    else positions.set(word, [index]);
  });
  const firstAtOrAfter = (word: string, from: number, before: number) => {
    for (const index of positions.get(word) ?? []) {
      if (index >= before) return -1;
      if (index >= from) return index;
    }
    return -1;
  };

  // A little wider than the quote, so a few extra words in the source don't break the match.
  const width = q.length + Math.max(2, Math.ceil(q.length * 0.2));
  const lastStart = Math.max(0, h.length - Math.min(q.length, h.length));
  for (let start = 0; start <= lastStart; start++) {
    const end = start + width;
    let hits = 0;
    let negationMismatch = false;
    for (const { word, index } of content) {
      const at = firstAtOrAfter(word, start, end);
      if (at === -1) continue;
      hits++;
      if (isNegatedAt(q, index) !== isNegatedAt(h, at)) {
        negationMismatch = true;
        break;
      }
    }
    if (!negationMismatch && hits / content.length >= 0.85) return "fuzzy";
  }
  return "none";
}

/** Exported for citation-proposition.ts — a quote that passes this check is classified QUOTED
 * without needing an LLM call; only quotes that fail it need the harder paraphrased-vs-inferred
 * judgment call. */
export function containsQuote(official: string, quote: string): boolean {
  return matchQuote(official, quote) !== "none";
}

/** The heuristic. A quote/official pair with no exact or near match (see matchQuote) falls to
 * INVALID here. Kept as its own export so evaluateCitation can fall back to it (Jev unavailable/
 * erroring) and so a benchmark can compare it directly against evaluateCitationWithJev. */
export function evaluateCitationHeuristic(input: CitationCheckInput): CitationCheckResult {
  const quote = input.quotedText?.trim() ?? "";
  if (!quote) {
    return { status: "UNVERIFIED", notes: "No quotation supplied." };
  }

  const official = input.officialText?.trim() ?? "";
  if (!official) {
    return {
      status: "UNVERIFIED",
      notes: "No official text available to verify the quotation against. Do not treat this citation as confirmed.",
    };
  }

  const match = matchQuote(official, quote);
  if (match === "exact") {
    return {
      status: "VALID",
      match,
      notes: "Quoted language appears in the official text (normalized match). Lawyer should still confirm current validity.",
    };
  }
  if (match === "fuzzy") {
    return {
      status: "VALID",
      match,
      notes: "Quoted language closely matches the official text, though not word for word. Lawyer should still confirm current validity.",
    };
  }

  return {
    status: "INVALID",
    notes: "Quoted language was not found in the official text. Possible false citation.",
  };
}

/** Only meaningful when the quote isn't in the official text word for word — no match, or only a
 * near one (see matchQuote). An exact match is decided by the heuristic alone; this double-checks
 * what the heuristic would otherwise call INVALID, or a VALID it reached on a near match. */
export async function evaluateCitationWithJev(quote: string, official: string): Promise<CitationCheckResult> {
  const client = getTypeSafeClient();
  logger.info("Jev request", { feature: "citation-validity", question: "validity", officialText: official, quotedText: quote });
  const response = await client.systemOne({
    state: { officialText: official, quotedText: quote },
    questions: {
      validity: choice(
        "A lawyer cited quotedText as coming from officialText, but it does not appear there word for word. Classify the citation: VALID if officialText actually supports the same claim as quotedText, even if worded very differently; INVALID if officialText does not support quotedText and there is no real connection between them; ADVERSE if officialText actually contradicts or undermines what quotedText claims.",
        { VALID: null, INVALID: null, ADVERSE: null },
      ),
    },
  });
  const answer = response.answers.validity;
  logger.info("Jev response", {
    feature: "citation-validity",
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
  });

  const pct = Math.round(answer.confidence * 100);
  const notes =
    answer.choice === "VALID"
      ? `Jev found the official text supports this citation despite no direct textual match (confidence ${pct}%). Lawyer should still confirm current validity.`
      : answer.choice === "ADVERSE"
        ? `Jev found the official text appears to contradict or undermine this citation (confidence ${pct}%). Review before relying on it.`
        : `Jev found no textual match and no support for this citation in the official text (confidence ${pct}%). Possible false citation.`;
  return { status: answer.choice, notes };
}

/** Pilot flag — see benchmarks/jev-report-2026-09-21.md. Unset/false keeps the heuristic's answer
 * as final. Read per call rather than at load, so it can be switched (and tested) without a reload. */
function jevValidityEnabled(): boolean {
  return process.env.USE_JEV_VALIDITY === "true";
}

/** The heuristic decides an exact match and a missing official text by itself. Anything it can
 * only judge from words — no match (INVALID) or a near match (fuzzy VALID) — goes to Jev when the
 * flag is on, since that's where a paraphrase, a contradiction or a reversed quote hides (#363).
 * `jev` is the Jev call, a parameter so tests needn't make a live one. */
export async function evaluateCitation(
  input: CitationCheckInput,
  jev: (quote: string, official: string) => Promise<CitationCheckResult> = evaluateCitationWithJev,
): Promise<CitationCheckResult> {
  const heuristic = evaluateCitationHeuristic(input);
  const judgedFromWords = heuristic.status === "INVALID" || (heuristic.status === "VALID" && heuristic.match === "fuzzy");
  if (!jevValidityEnabled() || !judgedFromWords) return heuristic;

  try {
    return await jev(input.quotedText.trim(), input.officialText!.trim());
  } catch (err) {
    logger.warn("Jev error", { feature: "citation-validity", err });
    return heuristic;
  }
}
