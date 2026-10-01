import { parseAiJson } from "./response-parser";
import { stripChatWonderNoise } from "./chat-wonder-noise";
import { normalizeForMatch } from "./witness-extract-parse";
import { DAMAGE_KINDS, type DamageKindValue } from "./damages-compute";

export interface ExtractedDamageHead {
  kind: DamageKindValue;
  title: string;
  description: string | null;
  /** The figure the quote states; null for an entry with no amount (most remedies). */
  amount: number | null;
  documentId: string;
  /** Verbatim line from `documentId` — only kept when it was found in that text and holds the amount. */
  quote: string;
}

const MAX_TITLE = 120;
const MAX_DESCRIPTION = 500;
const MIN_QUOTE = 10;
const MAX_QUOTE = 300;

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

/**
 * `undefined` = no [DAMAGES] block found/parseable (distinct from an empty array, which means the
 * model found nothing). `docTexts` maps each document id sent to the model to its full text. An
 * entry is dropped when it cites any other id, when its quote isn't in that document's text, or
 * when it gives an amount that isn't written in its quote — the model can't put a number in the
 * list without pointing at where it is. Never throws.
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

function normalizeRow(row: unknown, normalizedDocs: Map<string, string>): ExtractedDamageHead | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;

  if (!(DAMAGE_KINDS as readonly unknown[]).includes(r.kind)) return null;
  const title = str(r.title, MAX_TITLE);
  const documentId = str(r.documentId, 100);
  const quote = typeof r.quote === "string" ? r.quote.trim() : "";
  if (!title || !documentId || quote.length < MIN_QUOTE || quote.length > MAX_QUOTE) return null;

  const docText = normalizedDocs.get(documentId);
  if (docText === undefined || !docText.includes(normalizeForMatch(quote))) return null;

  let amount: number | null = null;
  if (r.amount !== null && r.amount !== undefined) {
    const n = num(r.amount);
    if (n === undefined || !quoteHas(numbersIn(quote), n)) return null;
    amount = n;
  }

  return {
    kind: r.kind as DamageKindValue,
    title,
    description: str(r.description, MAX_DESCRIPTION),
    amount,
    documentId,
    quote,
  };
}
