import { parseAiJson } from "./response-parser";
import { stripChatWonderNoise } from "./chat-wonder-noise";

export interface ExtractedWitness {
  name: string;
  role: string | null;
  summary: string | null;
  documentId: string;
  /** Verbatim line from `documentId` — only kept when it was actually found in that text. */
  quote: string;
}

const MAX_NAME = 120;
const MAX_ROLE = 120;
const MAX_SUMMARY = 400;
const MIN_QUOTE = 8;
const MAX_QUOTE = 300;

/** Lowercase, collapse whitespace, straighten quotes — so a quote survives the model re-flowing
 * line breaks or curling apostrophes, but not a paraphrase. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Dedupe key for a person's name: drops honorifics and punctuation so "Atty. Juan Dela Cruz"
 * and "juan dela cruz" collide. */
export function witnessNameKey(name: string): string {
  return normalizeForMatch(name)
    .replace(/[.,'"()]/g, " ")
    .replace(/\b(mr|mrs|ms|miss|dr|atty|attorney|hon|sir|dame|prof|engr|sr|jr)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * `undefined` = no [WITNESSES] block found/parseable (distinct from an empty array, which means
 * the model found nobody). `docTexts` maps each document id sent to the model to its full text:
 * an entry citing any other id, or whose quote isn't in that document's text, is dropped — the
 * model can't put a person on the list without pointing at where they appear. Never throws.
 */
export function extractWitnesses(text: string, docTexts: Map<string, string>): ExtractedWitness[] | undefined {
  const cleaned = stripChatWonderNoise(text);
  const closed = cleaned.match(/\[WITNESSES\]([\s\S]*?)\[\/WITNESSES\]/i);
  let jsonStr = closed ? closed[1].trim() : "";
  if (!jsonStr) {
    const open = cleaned.match(/\[WITNESSES\]([\s\S]*?)(?:\[(?:\/)?[A-Z_]+\]|$)/i);
    jsonStr = open ? open[1].trim() : "";
  }
  if (!jsonStr) return undefined;

  jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const parsed = parseAiJson(jsonStr);
  if (!Array.isArray(parsed)) return undefined;

  const normalizedDocs = new Map([...docTexts].map(([id, t]) => [id, normalizeForMatch(t)]));
  const seen = new Set<string>();
  const results: ExtractedWitness[] = [];
  for (const row of parsed) {
    const w = normalizeRow(row, normalizedDocs);
    if (!w) continue;
    const key = witnessNameKey(w.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    results.push(w);
  }
  return results;
}

function str(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.trim().slice(0, max) || null : null;
}

function normalizeRow(row: unknown, normalizedDocs: Map<string, string>): ExtractedWitness | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;

  const name = str(r.name, MAX_NAME);
  const documentId = str(r.documentId, 100);
  const quote = typeof r.quote === "string" ? r.quote.trim() : "";
  if (!name || !documentId || quote.length < MIN_QUOTE || quote.length > MAX_QUOTE) return null;

  const docText = normalizedDocs.get(documentId);
  if (docText === undefined || !docText.includes(normalizeForMatch(quote))) return null;

  return { name, role: str(r.role, MAX_ROLE), summary: str(r.summary, MAX_SUMMARY), documentId, quote };
}
