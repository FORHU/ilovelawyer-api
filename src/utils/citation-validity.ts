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
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[“”"']/g, "")
    .trim();
}

/** Exported for citation-proposition.ts — a quote that passes this check is classified QUOTED
 * without needing an LLM call; only quotes that fail it need the harder paraphrased-vs-inferred
 * judgment call. */
export function containsQuote(official: string, quote: string): boolean {
  const hay = normalize(official);
  const needle = normalize(quote);
  if (needle.length < 12) return hay.includes(needle);
  if (hay.includes(needle)) return true;
  const words = needle.split(" ").filter((w) => w.length > 3);
  if (words.length < 4) return false;
  const hits = words.filter((w) => hay.includes(w)).length;
  return hits / words.length >= 0.85;
}

/** The original heuristic, unchanged — a quote/official pair with no normalized textual match
 * always falls to INVALID here. Kept as its own export so evaluateCitation can fall back to it
 * (Jev unavailable/erroring) and so a benchmark can compare it directly against
 * evaluateCitationWithJev on the same ambiguous cases. */
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

  if (containsQuote(official, quote)) {
    return {
      status: "VALID",
      notes: "Quoted language appears in the official text (normalized match). Lawyer should still confirm current validity.",
    };
  }

  return {
    status: "INVALID",
    notes: "Quoted language was not found in the official text. Possible false citation.",
  };
}

/** Only meaningful for the ambiguous case — quote and official text both present, but no
 * normalized textual match (see containsQuote). A clean match is decided by the heuristic alone;
 * this only runs to double-check what the heuristic would otherwise call INVALID. */
export async function evaluateCitationWithJev(quote: string, official: string): Promise<CitationCheckResult> {
  const client = getTypeSafeClient();
  logger.info("Jev request", { feature: "citation-validity", question: "validity", officialText: official, quotedText: quote });
  const response = await client.systemOne({
    state: { officialText: official, quotedText: quote },
    questions: {
      validity: choice(
        "A lawyer cited quotedText as coming from officialText, but no close textual match was found. Classify the citation: VALID if officialText actually supports the same claim as quotedText, even if worded very differently; INVALID if officialText does not support quotedText and there is no real connection between them; ADVERSE if officialText actually contradicts or undermines what quotedText claims.",
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

/** Pilot flag — see benchmarks/jev-report-2026-09-21.md. Unset/false keeps evaluateCitationHeuristic's
 * INVALID-by-default behavior for the ambiguous case. */
const USE_JEV_VALIDITY = process.env.USE_JEV_VALIDITY === "true";

export async function evaluateCitation(input: CitationCheckInput): Promise<CitationCheckResult> {
  const heuristic = evaluateCitationHeuristic(input);
  if (!USE_JEV_VALIDITY || heuristic.status !== "INVALID") return heuristic;

  try {
    return await evaluateCitationWithJev(input.quotedText.trim(), input.officialText!.trim());
  } catch (err) {
    logger.warn("Jev error", { feature: "citation-validity", err });
    return heuristic;
  }
}
