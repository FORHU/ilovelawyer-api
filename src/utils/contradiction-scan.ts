import { CONTRADICTION_FACT_KEYS, CONTRADICTION_KINDS } from "../constants/contradiction-scan.constants";
import type { ContradictionHit } from "./fact-extract";
import { parseAiJson } from "./response-parser";

const FACT_KEY_SET = new Set<string>(CONTRADICTION_FACT_KEYS);
const KIND_SET = new Set<string>(CONTRADICTION_KINDS);
const MAX_EXCERPT = 500;

function stripChatWonderNoise(text: string): string {
  return text
    .replace(/__END__$/g, "")
    .replace(/\[Sources\][\s\S]*$/i, "")
    .replace(/\[RELATED_QUERIES\][\s\S]*?\[\/RELATED_QUERIES\]/gi, "")
    .replace(/\[RELATED_CASES\][\s\S]*$/i, "")
    .replace(/\[TIMELINE\][\s\S]*?\[\/TIMELINE\]/gi, "")
    .replace(/\[MINDMAP\][\s\S]*?\[\/MINDMAP\]/gi, "")
    .trim();
}

/**
 * Pulls the [CONTRADICTIONS] JSON array out of a Chat Wonder reply.
 * `undefined` means the block was missing or unparseable (caller should fall back).
 * An empty array means the model explicitly found none.
 */
export function extractContradictionHits(text: string, allowedDocumentIds?: Set<string>): ContradictionHit[] | undefined {
  const cleaned = stripChatWonderNoise(text);
  const closed = cleaned.match(/\[CONTRADICTIONS\]([\s\S]*?)\[\/CONTRADICTIONS\]/i);
  let jsonStr = "";
  if (closed) {
    jsonStr = closed[1].trim();
  } else {
    const open = cleaned.match(/\[CONTRADICTIONS\]([\s\S]*)$/i);
    if (open) jsonStr = open[1].trim();
  }
  if (!jsonStr) return undefined;

  jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const parsed = parseAiJson(jsonStr);
  if (!Array.isArray(parsed)) return undefined;

  const hits: ContradictionHit[] = [];
  for (const row of parsed) {
    const hit = toContradictionHit(row, allowedDocumentIds);
    if (hit) hits.push(hit);
  }
  return hits;
}

function toContradictionHit(row: unknown, allowedDocumentIds?: Set<string>): ContradictionHit | null {
  if (!row || typeof row !== "object") return null;
  const raw = row as Record<string, unknown>;
  const leftDocumentId = stringify(raw.leftDocumentId);
  const rightDocumentId = stringify(raw.rightDocumentId);
  const leftValue = normalizeValue(stringify(raw.leftValue));
  const rightValue = normalizeValue(stringify(raw.rightValue));
  if (!leftDocumentId || !rightDocumentId) return null;
  if (!leftValue || !rightValue || leftValue === rightValue) return null;
  if (allowedDocumentIds && (!allowedDocumentIds.has(leftDocumentId) || !allowedDocumentIds.has(rightDocumentId))) {
    return null;
  }

  const leftExcerpt = stringify(raw.leftExcerpt).slice(0, MAX_EXCERPT);
  const rightExcerpt = stringify(raw.rightExcerpt).slice(0, MAX_EXCERPT);
  if (leftDocumentId === rightDocumentId && leftExcerpt === rightExcerpt) return null;

  const factKeyRaw = stringify(raw.factKey).toLowerCase().replace(/\s+/g, "_");
  const kindRaw = stringify(raw.kind).toLowerCase().replace(/\s+/g, "_");

  return {
    kind: KIND_SET.has(kindRaw) ? kindRaw : inferKind(factKeyRaw),
    factKey: FACT_KEY_SET.has(factKeyRaw) ? factKeyRaw : "other",
    leftValue,
    rightValue,
    leftExcerpt,
    rightExcerpt,
    leftDocumentId,
    rightDocumentId,
    confidence: clampConfidence(raw.confidence),
  };
}

function inferKind(factKey: string): string {
  if (factKey.includes("date")) return "date_mismatch";
  if (factKey.startsWith("party_")) return "party_mismatch";
  if (
    factKey.includes("amount") ||
    factKey.includes("price") ||
    factKey.includes("damages") ||
    factKey.includes("deposit")
  ) {
    return "amount_mismatch";
  }
  return "other_mismatch";
}

function stringify(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

function normalizeValue(value: string): string {
  const stripped = value.replace(/[₱$,]/g, "").replace(/^(?:PHP|PhP|P)\s*/i, "").trim();
  if (/^\d+(\.\d+)?$/.test(stripped)) return stripped;
  const iso = value.match(/\b(20\d{2}|19\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  return value;
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0.8;
  return Math.min(1, Math.max(0, n));
}

export function uniqueContradictionHits(hits: ContradictionHit[]): ContradictionHit[] {
  const unique = new Map<string, ContradictionHit>();
  for (const hit of hits) {
    const key = [hit.kind, hit.factKey, hit.leftDocumentId, hit.rightDocumentId, hit.leftValue, hit.rightValue]
      .sort()
      .join("|");
    if (!unique.has(key)) unique.set(key, hit);
  }
  return [...unique.values()];
}
