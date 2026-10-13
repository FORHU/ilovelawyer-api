import { choice } from "@typesafe-ai/sdk";
import { callChatWonderRest, getChatWonderSessionId } from "./chatWonder";
import { buildCitationPropositionPrompt } from "../legal/prompts";
import { extractProposition, ParsedProposition } from "./citation-proposition-parse";
import { TenantCode } from "../types/tenant-code";
import { containsQuote } from "./citation-validity";
import { jevAsk } from "./typesafeClient";
import { optionsInOrder } from "./jev-common";
import logger from "./logger";

/** Pilot flag for the Jev-based path below — see benchmarks/jev-report-2026-09-21.md. Unset/false keeps the
 * existing chat-wonder + regex path. */
const USE_JEV_PROPOSITION = process.env.USE_JEV_PROPOSITION === "true";

export const JEV_PROPOSITION_TYPES = ["PARAPHRASED", "INFERRED"] as const;

/** The exact request classifyPropositionWithJev sends; `order` is for the option-order benchmark (#410). */
export function propositionRequest(quote: string, official: string, order: readonly (typeof JEV_PROPOSITION_TYPES)[number][] = JEV_PROPOSITION_TYPES) {
  return {
    state: { officialText: official, quotedText: quote },
    questions: {
      propositionType: choice(
        "Given officialText (the source document) and quotedText (a proposition derived from it), classify their relationship: PARAPHRASED if quotedText restates the same meaning in different words, INFERRED if it is a conclusion drawn from officialText but not directly stated there.",
        optionsInOrder(order),
      ),
    },
  };
}

export async function classifyPropositionWithJev(quote: string, official: string): Promise<ParsedProposition | null> {
  logger.info("Jev request", { feature: "citation-proposition", question: "propositionType", officialText: official, quotedText: quote });
  const response = await jevAsk("citation-proposition", propositionRequest(quote, official));
  const answer = response.answers.propositionType;
  logger.info("Jev response", {
    feature: "citation-proposition",
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
  });
  if (answer.choice !== "PARAPHRASED" && answer.choice !== "INFERRED") return null;
  return { type: answer.choice, reasoning: null };
}

export async function classifyPropositionWithChatWonder(
  quote: string,
  official: string,
  tenantCode: TenantCode,
): Promise<ParsedProposition | null> {
  const sessionId = await getChatWonderSessionId();
  const prompt = buildCitationPropositionPrompt(quote, official);
  const payload = await callChatWonderRest(prompt, sessionId, undefined, tenantCode, { usage: { feature: "citationProposition" } });
  const text = String(payload.response || payload.intermediate_response || "");
  return extractProposition(text);
}

/**
 * Classifies how quotedText relates to officialText: QUOTED needs no LLM call at all — the
 * existing plain-text match (containsQuote) already answers it — so only quotes that fail that
 * check pay for a classification call. Never throws — a failed/unparseable classification just
 * returns null (propositionType stays unset), same as every other AI-derived field here.
 */
export async function classifyProposition(
  quotedText: string,
  officialText: string | null | undefined,
  tenantCode: TenantCode,
): Promise<ParsedProposition | null> {
  const quote = quotedText?.trim();
  const official = officialText?.trim();
  if (!quote || !official) return null;

  if (containsQuote(official, quote)) {
    return { type: "QUOTED", reasoning: null };
  }

  if (USE_JEV_PROPOSITION) {
    try {
      return await classifyPropositionWithJev(quote, official);
    } catch (err) {
      logger.warn("Jev error", { feature: "citation-proposition", err });
      return null;
    }
  }

  try {
    return await classifyPropositionWithChatWonder(quote, official, tenantCode);
  } catch (err) {
    logger.warn("Citation proposition classification failed", { err });
    return null;
  }
}
