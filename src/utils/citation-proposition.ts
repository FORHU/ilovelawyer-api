import { callChatWonderRest, getChatWonderSessionId } from "./chatWonder";
import { buildCitationPropositionPrompt } from "../legal/prompts";
import { extractProposition, ParsedProposition } from "./citation-proposition-parse";
import { TenantCode } from "../types/tenant-code";
import { containsQuote } from "./citation-validity";
import logger from "./logger";

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

  try {
    const sessionId = await getChatWonderSessionId();
    const prompt = buildCitationPropositionPrompt(quote, official);
    const payload = await callChatWonderRest(prompt, sessionId, undefined, tenantCode);
    const text = String(payload.response || payload.intermediate_response || "");
    return extractProposition(text);
  } catch (err) {
    logger.warn("Citation proposition classification failed", { err });
    return null;
  }
}
