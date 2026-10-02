import { parseAiJson } from "./response-parser";
import { stripChatWonderNoise } from "./chat-wonder-noise";
import { normalizeForMatch } from "./witness-extract-parse";
import { DAMAGE_KINDS, type DamageKindValue } from "./damages-compute";
import { resolveDocumentRef, type CaseDoc } from "./case-document-handles";

/** A figure worked out from two numbers the documents state — "12 weeks' notice" and "£450 a
 * week". The model only names the inputs; the amount is multiplied here, never by the model. */
export interface DamageCalculation {
  rate: number;
  count: number;
  unit: "day" | "week" | "month" | "year";
}

/** Where an entry's amount came from — see DamageClaim.amountBasis. */
export type DamageAmountBasisValue = "STATED" | "CALCULATED" | "ESTIMATE";

export interface ExtractedDamageHead {
  kind: DamageKindValue;
  title: string;
  description: string | null;
  /** The stated figure, rate × count when a calculation is given, or the model's estimate when the
   * documents give neither; null for a remedy with none. */
  amount: number | null;
  calculation: DamageCalculation | null;
  amountBasis: DamageAmountBasisValue | null;
  /** The working behind the amount: the calculation, or how an estimate was reached. */
  amountNote: string | null;
  /** The first quoted document. */
  documentId: string;
  /** Verbatim lines, each found in its own document's text, holding every number the entry uses. */
  quotes: { documentId: string; quote: string }[];
  /** The quotes as one line — what is saved as the entry's source quote and what Jev reads. */
  quote: string;
  /** What Jev checks the quote against: the stated amount, or the calculation's inputs (the
   * product itself is written nowhere); null when there is no figure to check — no amount, or an
   * estimate, which no quote states. */
  figure: string | null;
}

const MAX_TITLE = 120;
const MAX_DESCRIPTION = 500;
const MAX_ESTIMATE_BASIS = 300;
const MIN_QUOTE = 10;
const MAX_QUOTE = 300;
const MAX_QUOTES = 3;
const UNITS = ["day", "week", "month", "year"] as const;
const QUOTE_JOINER = " … ";

/** One entry per kind and title, so "Backwages" proposed twice — or already on the case — is one
 * entry. Used to dedupe a batch and to skip entries the case already has. */
export function damageHeadKey(kind: string, title: string | null | undefined): string {
  return `${kind}:${normalizeForMatch(title ?? "")}`;
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

/** "12 weeks × 450 a week" — the calculation in words, for the entry's description. */
export function describeCalculation(c: DamageCalculation): string {
  return `${c.count} ${c.unit}${c.count === 1 ? "" : "s"} × ${c.rate} a ${c.unit}`;
}

/**
 * `undefined` = no [DAMAGES] block found/parseable (distinct from an empty array, which means the
 * model found nothing). `docTexts` maps each document id sent to the model to its full text, and
 * `docs` lists those documents so a citation by handle (D1), id or name resolves to one. An entry
 * is dropped when a quote cites no known document or isn't in that document's text, or when a
 * number it uses (the amount, or a calculation's rate and count) is in none of its quotes — the
 * model can't put a number in the list without pointing at where it is written. The one exception
 * is an estimate, which a DAMAGE with neither may carry: its amount is the model's own, and it is
 * kept only with a stated basis, marked ESTIMATE so the panel shows it as one. Never throws.
 */
export function extractDamageHeads(text: string, docTexts: Map<string, string>, docs: CaseDoc[]): ExtractedDamageHead[] | undefined {
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
    const head = normalizeRow(row, normalizedDocs, docs);
    if (!head) continue;
    const key = damageHeadKey(head.kind, head.title);
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

/** The entry's quotes — `quotes: [{documentId, quote}]`, or the older single documentId + quote —
 * each resolved to a case document and found in its text; null if any one fails. */
function quotesOf(
  r: Record<string, unknown>,
  normalizedDocs: Map<string, string>,
  docs: CaseDoc[],
): { documentId: string; quote: string }[] | null {
  const raw = Array.isArray(r.quotes) ? r.quotes.slice(0, MAX_QUOTES) : [{ documentId: r.documentId, quote: r.quote }];
  const out: { documentId: string; quote: string }[] = [];
  for (const item of raw) {
    const q = item as Record<string, unknown> | null;
    const ref = str(q?.documentId, 100);
    const quote = typeof q?.quote === "string" ? q.quote.trim() : "";
    const documentId = ref ? resolveDocumentRef(ref, docs) : null;
    if (!documentId || quote.length < MIN_QUOTE || quote.length > MAX_QUOTE) return null;
    const docText = normalizedDocs.get(documentId);
    if (docText === undefined || !docText.includes(normalizeForMatch(quote))) return null;
    out.push({ documentId, quote });
  }
  return out.length ? out : null;
}

export function estimateOf(raw: unknown): { amount: number; basis: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const amount = num(e.amount);
  const basis = str(e.basis, MAX_ESTIMATE_BASIS);
  return amount !== undefined && amount > 0 && basis ? { amount: Math.round(amount * 100) / 100, basis } : null;
}

function calculationOf(raw: unknown, numbers: number[]): DamageCalculation | null | undefined {
  if (raw === null || raw === undefined) return null;
  const c = raw as Record<string, unknown>;
  const rate = num(c.rate);
  const count = num(c.count);
  const unit = typeof c.unit === "string" ? c.unit.toLowerCase().replace(/s$/, "") : "";
  if (rate === undefined || count === undefined || count <= 0 || !(UNITS as readonly string[]).includes(unit)) return undefined;
  if (!quoteHas(numbers, rate) || !quoteHas(numbers, count)) return undefined;
  return { rate, count, unit: unit as DamageCalculation["unit"] };
}

function normalizeRow(row: unknown, normalizedDocs: Map<string, string>, docs: CaseDoc[]): ExtractedDamageHead | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;

  if (!(DAMAGE_KINDS as readonly unknown[]).includes(r.kind)) return null;
  const title = str(r.title, MAX_TITLE);
  if (!title) return null;
  const quotes = quotesOf(r, normalizedDocs, docs);
  if (!quotes) return null;
  const numbers = quotes.flatMap((q) => numbersIn(q.quote));

  // A calculation wins over a stated amount; either must be backed by the quotes.
  const calculation = calculationOf(r.calculation, numbers);
  if (calculation === undefined) return null;
  let amount: number | null = null;
  let amountBasis: DamageAmountBasisValue | null = null;
  let amountNote: string | null = null;
  if (calculation) {
    amount = Math.round(calculation.rate * calculation.count * 100) / 100;
    amountBasis = "CALCULATED";
    amountNote = describeCalculation(calculation);
  } else if (r.amount !== null && r.amount !== undefined) {
    const n = num(r.amount);
    if (n === undefined || !quoteHas(numbers, n)) return null;
    amount = n;
    amountBasis = "STATED";
  } else if (r.kind === "DAMAGE") {
    // No figure in the documents: the model's estimate, for the lawyer to check and edit.
    const estimate = estimateOf(r.estimate);
    if (estimate) {
      amount = estimate.amount;
      amountBasis = "ESTIMATE";
      amountNote = estimate.basis;
    }
  }

  return {
    kind: r.kind as DamageKindValue,
    title,
    description: str(r.description, MAX_DESCRIPTION),
    amount,
    calculation,
    amountBasis,
    amountNote,
    documentId: quotes[0]!.documentId,
    quotes,
    quote: quotes.map((q) => q.quote).join(QUOTE_JOINER),
    figure: amountBasis === "CALCULATED" ? amountNote : amountBasis === "STATED" ? String(amount) : null,
  };
}

/**
 * The reply to the follow-up estimate request (buildDamagesEstimatePrompt): an [ESTIMATES] block of
 * {title, amount, basis}. Returns each usable estimate by damageHeadKey("DAMAGE", title); an entry
 * with no positive amount or no basis is left out. Empty when there is no block. Never throws.
 */
export function parseDamageEstimates(text: string): Map<string, { amount: number; basis: string }> {
  const out = new Map<string, { amount: number; basis: string }>();
  const cleaned = stripChatWonderNoise(text);
  const match = cleaned.match(/\[ESTIMATES\]([\s\S]*?)(?:\[\/ESTIMATES\]|$)/i);
  if (!match) return out;
  const parsed = parseAiJson(match[1].trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim());
  if (!Array.isArray(parsed)) return out;
  for (const row of parsed) {
    const title = str((row as Record<string, unknown> | null)?.title, MAX_TITLE);
    const estimate = estimateOf(row);
    if (title && estimate) out.set(damageHeadKey("DAMAGE", title), estimate);
  }
  return out;
}
