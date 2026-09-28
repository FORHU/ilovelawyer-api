import { parseAiJson } from "./response-parser";
import { stripChatWonderNoise } from "./chat-wonder-noise";
import { normalizeForMatch } from "./witness-extract-parse";

export interface ExtractedClaim {
  title: string;
  causeOfAction: string | null;
  documentId: string;
  /** Verbatim line from `documentId` — only kept when it was actually found in that text. */
  quote: string;
}

const MAX_TITLE = 80;
const MAX_CAUSE = 200;
const MIN_QUOTE = 8;
const MAX_QUOTE = 300;

/** Dedupe key for a claim title: case, punctuation and a leading "claim for" don't make it a
 * different claim. */
export function claimTitleKey(title: string): string {
  return normalizeForMatch(title)
    .replace(/[.,;:'"()]/g, " ")
    .replace(/^(claim|complaint|action)s? (for|of) /, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * `undefined` = no [CLAIMS] block found/parseable (distinct from an empty array, which means the
 * model found no pleaded claim). `docTexts` maps each document id sent to the model to its full
 * text: an entry citing any other id, or whose quote isn't in that document's text, is dropped —
 * the model can't put a claim on the list without pointing at where it's pleaded. Never throws.
 * Mirrors extractWitnesses.
 */
export function extractClaims(text: string, docTexts: Map<string, string>): ExtractedClaim[] | undefined {
  const cleaned = stripChatWonderNoise(text);
  const closed = cleaned.match(/\[CLAIMS\]([\s\S]*?)\[\/CLAIMS\]/i);
  let jsonStr = closed ? closed[1].trim() : "";
  if (!jsonStr) {
    const open = cleaned.match(/\[CLAIMS\]([\s\S]*?)(?:\[(?:\/)?[A-Z_]+\]|$)/i);
    jsonStr = open ? open[1].trim() : "";
  }
  if (!jsonStr) return undefined;

  jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const parsed = parseAiJson(jsonStr);
  if (!Array.isArray(parsed)) return undefined;

  const normalizedDocs = new Map([...docTexts].map(([id, t]) => [id, normalizeForMatch(t)]));
  const seen = new Set<string>();
  const results: ExtractedClaim[] = [];
  for (const row of parsed) {
    const claim = normalizeRow(row, normalizedDocs);
    if (!claim) continue;
    const key = claimTitleKey(claim.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    results.push(claim);
  }
  return results;
}

function str(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) || null : null;
}

function normalizeRow(row: unknown, normalizedDocs: Map<string, string>): ExtractedClaim | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;

  const title = str(r.title, MAX_TITLE);
  const documentId = str(r.documentId, 100);
  const quote = typeof r.quote === "string" ? r.quote.trim() : "";
  if (!title || !documentId || quote.length < MIN_QUOTE || quote.length > MAX_QUOTE) return null;

  const docText = normalizedDocs.get(documentId);
  if (docText === undefined || !docText.includes(normalizeForMatch(quote))) return null;

  return { title, causeOfAction: str(r.causeOfAction, MAX_CAUSE), documentId, quote };
}
