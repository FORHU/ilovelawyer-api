import { parseAiJson } from "./response-parser";
import { stripChatWonderNoise } from "./chat-wonder-noise";
import { normalizeForMatch } from "./witness-extract-parse";
import { DAMAGE_CATEGORIES, type DamageBasis, type DamageCategoryValue } from "./damages-compute";

export interface ExtractedDamageHead {
  category: DamageCategoryValue;
  label: string | null;
  basis: DamageBasis;
  /** The stated figure for a FIXED head (DamageClaim.amount); null for the other kinds, whose
   * amount damages-compute works out. */
  amount: number | null;
  legalBasis: string | null;
  pendingEvidence: string | null;
  documentId: string;
  /** Verbatim line from `documentId` — only kept when it was found in that text and holds the figures. */
  quote: string;
}

const MAX_LABEL = 120;
const MAX_LEGAL_BASIS = 300;
const MAX_PENDING = 200;
const MIN_QUOTE = 10;
const MAX_QUOTE = 300;

/** One head per category, except OTHER, where "13th month pay" and "Service incentive leave" are
 * separate heads — so OTHER is keyed by its label too. Used to dedupe a batch and to skip heads the
 * case already has. */
export function damageHeadKey(category: string, label: string | null | undefined): string {
  return category === "OTHER" ? `OTHER:${normalizeForMatch(label ?? "")}` : category;
}

/** Every number written in `text`, thousands separators dropped: "P200,000.00 and 10%" → [200000, 10]. */
export function numbersIn(text: string): number[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [])
    .map((token) => Number(token.replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));
}

function quoteHas(numbers: number[], value: number): boolean {
  return numbers.some((n) => Math.abs(n - value) < 0.005);
}

/**
 * `undefined` = no [DAMAGES] block found/parseable (distinct from an empty array, which means the
 * model found no head with a figure). `docTexts` maps each document id sent to the model to its
 * full text. A head is dropped when it cites any other id, when its quote isn't in that
 * document's text, or when a figure it uses (amount, monthly rate, percent) isn't written in its
 * quote — the model can't put a number in the model without pointing at where it is. A stated
 * number of months that isn't in the quote is dropped on its own, leaving the rate for the lawyer
 * to set a period on. Never throws.
 */
export function extractDamageHeads(text: string, docTexts: Map<string, string>): ExtractedDamageHead[] | undefined {
  const cleaned = stripChatWonderNoise(text);
  const closed = cleaned.match(/\[DAMAGES\]([\s\S]*?)\[\/DAMAGES\]/i);
  let jsonStr = closed ? closed[1].trim() : "";
  if (!jsonStr) {
    const open = cleaned.match(/\[DAMAGES\]([\s\S]*?)(?:\[(?:\/)?[A-Z_]+\]|$)/i);
    jsonStr = open ? open[1].trim() : "";
  }
  if (!jsonStr) return undefined;

  jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const parsed = parseAiJson(jsonStr);
  if (!Array.isArray(parsed)) return undefined;

  const normalizedDocs = new Map([...docTexts].map(([id, t]) => [id, normalizeForMatch(t)]));
  const seen = new Set<string>();
  const results: ExtractedDamageHead[] = [];
  for (const row of parsed) {
    const head = normalizeRow(row, normalizedDocs);
    if (!head) continue;
    const key = damageHeadKey(head.category, head.label);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(head);
  }
  return results;
}

function str(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.trim().slice(0, max) || null : null;
}

function num(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value.replace(/,/g, "")) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

function basisFrom(raw: unknown, quoteNumbers: number[]): { basis: DamageBasis; amount: number | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (b.kind === "FIXED") {
    const amount = num(b.amount);
    return amount !== undefined && quoteHas(quoteNumbers, amount) ? { basis: { kind: "FIXED" }, amount } : null;
  }
  if (b.kind === "RATE_X_PERIOD") {
    const monthlyRate = num(b.monthlyRate);
    if (monthlyRate === undefined || !quoteHas(quoteNumbers, monthlyRate)) return null;
    const months = num(b.months);
    const withMonths = months !== undefined && months > 0 && months <= 1200 && quoteHas(quoteNumbers, months);
    return {
      basis: withMonths ? { kind: "RATE_X_PERIOD", monthlyRate, months } : { kind: "RATE_X_PERIOD", monthlyRate },
      amount: null,
    };
  }
  if (b.kind === "PERCENT_OF") {
    const percent = num(b.percent);
    const categories = Array.isArray(b.categories)
      ? [...new Set(b.categories.filter((c): c is DamageCategoryValue => (DAMAGE_CATEGORIES as readonly unknown[]).includes(c)))]
      : [];
    if (percent === undefined || percent > 100 || categories.length === 0 || !quoteHas(quoteNumbers, percent)) return null;
    return { basis: { kind: "PERCENT_OF", percent, categories }, amount: null };
  }
  return null;
}

function normalizeRow(row: unknown, normalizedDocs: Map<string, string>): ExtractedDamageHead | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;

  const category = r.category;
  if (!(DAMAGE_CATEGORIES as readonly unknown[]).includes(category)) return null;
  const documentId = str(r.documentId, 100);
  const quote = typeof r.quote === "string" ? r.quote.trim() : "";
  if (!documentId || quote.length < MIN_QUOTE || quote.length > MAX_QUOTE) return null;

  const docText = normalizedDocs.get(documentId);
  if (docText === undefined || !docText.includes(normalizeForMatch(quote))) return null;

  const built = basisFrom(r.basis, numbersIn(quote));
  if (!built) return null;

  return {
    category: category as DamageCategoryValue,
    label: str(r.label, MAX_LABEL),
    basis: built.basis,
    amount: built.amount,
    legalBasis: str(r.legalBasis, MAX_LEGAL_BASIS),
    pendingEvidence: str(r.pendingEvidence, MAX_PENDING),
    documentId,
    quote,
  };
}
