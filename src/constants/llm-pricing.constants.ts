/** What an LLM call costs, for LlmUsage.estimatedCostUsd (epic #399).
 *
 * USD per 1,000,000 tokens, keyed by the model name as the provider reports it. A model with no
 * known price is left out, and estimateCostUsd then returns null — an unknown cost is never 0.
 *
 * Sources, all from the project's own spend ledger ("The Terra Ledger", Rev. 10, 10 Oct 2026, and
 * the earlier "Terra Spend Ledger"), not re-checked against the providers today:
 *  - gpt-5.6-terra: $2 in / $0.20 cached in / $12 out. Verified against developers.openai.com when
 *    the ledger was written.
 *  - gpt-5.6-luna: $0.20 in / $1.20 out, from a third-party tracker (anotherwrapper.com). OpenAI's
 *    own pricing page (checked 2026-10-11) lists only gpt-6-luna, so this is UNCONFIRMED there. No
 *    cached-input price is known, so cached tokens are billed as ordinary input (slightly high).
 *  - jev: $0.042 in, output free, from a cost comparison table. Applies to every Jev model version
 *    (key ends in "*", see below).
 *
 *  - gpt-4o ($2.50 in / $1.25 cached in / $10 out), gpt-4o-mini ($0.15 / $0.075 / $0.60) and
 *    text-embedding-3-small ($0.02 in, no output): read from OpenAI's own model pages,
 *    developers.openai.com/api/docs/models/<model>, on 2026-10-11. The ledger's "ILoveLawyer Model
 *    Audit" artifact agrees on gpt-4o's $2.50 / $10. These pages are not on the main pricing page
 *    (that lists only the newest models), so a future price change must be picked up from them.
 *
 * Any other model has no price, so its cost stays null until one is added.
 *
 * Reasoning tokens bill as output; Chat Wonder's reported completion_tokens is assumed to include
 * them. Add a line here and the cost fills in from then on (it is computed when the row is
 * written, so rows already written keep their null). */
export const PRICES_CHECKED_ON = "2026-10-11";

export interface ModelPrice {
  /** Per 1M input tokens, cached tokens included in the count. */
  input: number;
  /** Per 1M cached input tokens. Omit when unknown or not discounted; cached tokens then bill as input. */
  cachedInput?: number;
  /** Per 1M output tokens. */
  output: number;
}

/** A key ending in "*" matches every model whose name starts with the text before it. */
export const LLM_PRICES: Record<string, ModelPrice> = {
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10 },
  "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "jev*": { input: 0.042, output: 0 },
};

/** The rate an account's unpriced Chat Wonder rows are charged at against its free credit (LlmUsageSvc.chatWonderSpendUsd):
 * the chat model, the dearest in the table, so an unknown cost never undercounts the budget. */
export const FREE_CREDIT_UNPRICED_MODEL = "gpt-5.6-terra";

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  /** A subset of inputTokens. */
  cachedInputTokens?: number | null;
}

/** The price for a reported model name: an exact key, then the name without a trailing snapshot
 * date ("gpt-5.6-luna-2026-09-01" → "gpt-5.6-luna"), then a "prefix*" key. */
export function findPrice(model: string, prices: Record<string, ModelPrice> = LLM_PRICES): ModelPrice | undefined {
  const name = model.trim().toLowerCase();
  const direct = prices[name] ?? prices[name.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
  if (direct) return direct;
  const wildcard = Object.keys(prices).find((key) => key.endsWith("*") && name.startsWith(key.slice(0, -1)));
  return wildcard ? prices[wildcard] : undefined;
}

/** USD for one call, or null when the model is unknown or has no known price. */
export function estimateCostUsd(
  model: string | null | undefined,
  tokens: TokenCounts,
  prices: Record<string, ModelPrice> = LLM_PRICES,
): number | null {
  if (!model) return null;
  const price = findPrice(model, prices);
  if (!price) return null;
  const cached = Math.min(Math.max(tokens.cachedInputTokens ?? 0, 0), tokens.inputTokens);
  const uncached = tokens.inputTokens - cached;
  const cachedRate = price.cachedInput ?? price.input;
  return (uncached * price.input + cached * cachedRate + tokens.outputTokens * price.output) / 1_000_000;
}
