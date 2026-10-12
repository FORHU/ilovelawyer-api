/** A rough token count for text we sent to or got back from an LLM that didn't tell us its own
 * numbers (Chat Wonder, until chat-wonder-v2-api#104 — see epic #399). Characters / 4 is the usual
 * rule of thumb for English prose. It is biased toward English: Filipino, code, JSON and
 * non-Latin scripts tokenize into more tokens per character, so it under-counts those. Good enough
 * to see trends, not billing-accurate — rows built from it are marked ESTIMATED. */
export function estimateTokensFromChars(chars: number): number {
  return chars > 0 ? Math.ceil(chars / 4) : 0;
}

export function estimateTokens(text: string | null | undefined): number {
  return text ? estimateTokensFromChars(text.length) : 0;
}
