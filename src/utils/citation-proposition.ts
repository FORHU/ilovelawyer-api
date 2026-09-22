import { choice } from "@typesafe-ai/sdk";
import { callChatWonderRest, getChatWonderSessionId } from "./chatWonder";
import { buildCitationPropositionPrompt } from "../legal/prompts";
import { extractProposition, ParsedProposition } from "./citation-proposition-parse";
import { TenantCode } from "../types/tenant-code";
import { containsQuote } from "./citation-validity";
import { getTypeSafeClient } from "./typesafeClient";
import logger from "./logger";

/** Pilot flag for the Jev-based path below — see docs/Jev integration doc. Unset/false keeps the
 * existing chat-wonder + regex path. */
const USE_JEV_PROPOSITION = process.env.USE_JEV_PROPOSITION === "true";

export async function classifyPropositionWithJev(quote: string, official: string): Promise<ParsedProposition | null> {
  const client = getTypeSafeClient();
  logger.info("Jev request", { feature: "citation-proposition", question: "propositionType", officialText: official, quotedText: quote });
  const response = await client.systemOne({
    state: { officialText: official, quotedText: quote },
    questions: {
      propositionType: choice(
        "Given officialText (the source document) and quotedText (a proposition derived from it), classify their relationship: PARAPHRASED if quotedText restates the same meaning in different words, INFERRED if it is a conclusion drawn from officialText but not directly stated there.",
        { PARAPHRASED: null, INFERRED: null },
      ),
    },
  });
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
  const payload = await callChatWonderRest(prompt, sessionId, undefined, tenantCode);
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
