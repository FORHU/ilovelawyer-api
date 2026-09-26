import { parseAiJson } from "./response-parser";
import { stripChatWonderNoise } from "./chat-wonder-noise";
import { FACTOR_KEYS, RUBRIC, type FactorKey } from "./witness-rubric";

export interface WitnessScoreReason {
  text: string;
  /** The evidence item, contradiction or timeline entry the reason relies on. Null when the model
   * gave none — the UI shows the reason without a source chip rather than inventing one. */
  source: string | null;
}

export interface WitnessFactorAnswer {
  /** One of the factor's options, or null when the model said the papers don't show it. */
  answer: string | null;
  /** Verbatim passage the model relied on. Checked against the source text by the caller. */
  quote: string | null;
  /** Name of the document the quote is from. */
  document: string | null;
}

export interface WitnessFactorRow {
  witnessId: string;
  factors: Record<FactorKey, WitnessFactorAnswer>;
  reasons: WitnessScoreReason[];
  /** Next step the model suggested for each factor it could not answer. */
  needs: Partial<Record<FactorKey, string>>;
}

const MAX_NEED = 300;
const MAX_REASONS = 4;
const MAX_TEXT = 400;
const MAX_SOURCE = 200;
const MAX_QUOTE = 600;

/** `undefined` = no [SCORES] block found/parseable (distinct from an empty array). Only ids in
 * `knownIds` survive, so a hallucinated witness can never create or touch a row. Never throws. */
export function extractWitnessFactors(text: string, knownIds: Set<string>): WitnessFactorRow[] | undefined {
  const cleaned = stripChatWonderNoise(text);
  const closed = cleaned.match(/\[SCORES\]([\s\S]*?)\[\/SCORES\]/i);
  let jsonStr = closed ? closed[1].trim() : "";
  if (!jsonStr) {
    const open = cleaned.match(/\[SCORES\]([\s\S]*?)(?:\[(?:\/)?[A-Z_]+\]|$)/i);
    jsonStr = open ? open[1].trim() : "";
  }
  if (!jsonStr) return undefined;

  jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const parsed = parseAiJson(jsonStr);
  if (!Array.isArray(parsed)) return undefined;

  const seen = new Set<string>();
  const results: WitnessFactorRow[] = [];
  for (const row of parsed) {
    const normalized = normalizeRow(row, knownIds);
    if (normalized && !seen.has(normalized.witnessId)) {
      seen.add(normalized.witnessId);
      results.push(normalized);
    }
  }
  return results;
}

function clean(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.trim().slice(0, max) || null : null;
}

function normalizeFactor(key: FactorKey, raw: unknown): WitnessFactorAnswer {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const answerRaw = typeof r.answer === "string" ? r.answer.trim().toUpperCase() : "";
  // An answer that isn't one of the factor's options is dropped: not assessable, never a guess.
  const answer = Object.prototype.hasOwnProperty.call(RUBRIC[key].options, answerRaw) ? answerRaw : null;
  return { answer, quote: clean(r.quote, MAX_QUOTE), document: clean(r.document, MAX_SOURCE) };
}

function normalizeRow(row: unknown, knownIds: Set<string>): WitnessFactorRow | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;

  const witnessId = typeof r.witnessId === "string" ? r.witnessId.trim() : "";
  if (!knownIds.has(witnessId)) return null;

  const rawFactors = r.factors && typeof r.factors === "object" ? (r.factors as Record<string, unknown>) : {};
  const factors = {} as Record<FactorKey, WitnessFactorAnswer>;
  for (const key of FACTOR_KEYS) factors[key] = normalizeFactor(key, rawFactors[key]);

  const reasons: WitnessScoreReason[] = [];
  if (Array.isArray(r.reasons)) {
    for (const item of r.reasons.slice(0, MAX_REASONS)) {
      if (!item || typeof item !== "object") continue;
      const ir = item as Record<string, unknown>;
      const text = clean(ir.text, MAX_TEXT);
      if (!text) continue;
      reasons.push({ text, source: clean(ir.source, MAX_SOURCE) });
    }
  }

  const needs: Partial<Record<FactorKey, string>> = {};
  if (Array.isArray(r.needs)) {
    for (const item of r.needs) {
      if (!item || typeof item !== "object") continue;
      const ir = item as Record<string, unknown>;
      const factor = typeof ir.factor === "string" ? (ir.factor.trim().toUpperCase() as FactorKey) : null;
      const text = clean(ir.text, MAX_NEED);
      if (factor && FACTOR_KEYS.includes(factor) && text && !needs[factor]) needs[factor] = text;
    }
  }

  return { witnessId, factors, reasons, needs };
}

function normalizeForMatch(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** True when `quote` appears verbatim in `source` (ignoring case, curly quotes and whitespace). */
export function quoteAppearsIn(quote: string, source: string): boolean {
  const q = normalizeForMatch(quote);
  return q.length > 0 && normalizeForMatch(source).includes(q);
}
