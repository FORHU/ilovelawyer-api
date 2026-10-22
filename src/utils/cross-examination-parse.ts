import { parseAiJson } from "./response-parser";
import { stripChatWonderNoise } from "./chat-wonder-noise";
import { clampText } from "./case-finding-parse";
import { normalizeForMatch } from "./witness-scoring-parse";
import { CROSS_EXAM_MAX_QUESTIONS, CROSS_EXAM_MAX_QUOTE } from "../constants/cross-examination.constants";

const TAG = "CROSS_EXAMINATION";
const MAX_TOPIC = 80;
const MAX_QUESTION = 300;
const MAX_PURPOSE = 200;
// A shorter passage matches too easily by chance to count as the source of a question.
const MIN_QUOTE = 12;

export interface ParsedCrossExamQuestion {
  topic: string;
  question: string;
  purpose: string | null;
  /** The document handle the model cited (D1, D2, …) — resolved by the caller, which holds the map. */
  documentHandle: string;
  quote: string;
}

/** `undefined` = no parseable block, so the caller keeps what the witness already has. An empty
 * array = the model found nothing to put to this witness. Mirrors extractMissingEvidence. */
export function extractCrossExamination(text: string): ParsedCrossExamQuestion[] | undefined {
  const cleaned = stripChatWonderNoise(text);
  const closed = cleaned.match(new RegExp(`\\[${TAG}\\]([\\s\\S]*?)\\[\\/${TAG}\\]`, "i"));
  // An unclosed block (the reply was cut off) still parses up to the next tag or the end.
  const open = closed ? null : cleaned.match(new RegExp(`\\[${TAG}\\]([\\s\\S]*?)(?:\\[(?:\\/)?[A-Z_]+\\]|$)`, "i"));
  const block = (closed ?? open)?.[1]?.trim();
  if (!block) return undefined;

  const parsed = parseAiJson(block.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim());
  if (!Array.isArray(parsed)) return undefined;

  const items: ParsedCrossExamQuestion[] = [];
  const seen = new Set<string>();
  for (const row of parsed) {
    const item = normalizeItem(row);
    if (!item) continue;
    const key = item.question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length === CROSS_EXAM_MAX_QUESTIONS) break;
  }
  return items;
}

function normalizeItem(row: unknown): ParsedCrossExamQuestion | null {
  if (!row || typeof row !== "object") return null;
  const r = row as { topic?: unknown; question?: unknown; purpose?: unknown; document?: unknown; quote?: unknown };
  if (typeof r.question !== "string" || typeof r.quote !== "string" || typeof r.document !== "string") return null;
  const question = clampText(r.question, MAX_QUESTION);
  // The quote is never clamped: a shortened quote would no longer match its document, and one
  // over the limit is a joined or padded passage rather than a single one.
  const quote = r.quote.replace(/\s+/g, " ").trim();
  if (!question || quote.length < MIN_QUOTE || quote.length > CROSS_EXAM_MAX_QUOTE) return null;
  const documentHandle = r.document.trim().replace(/^\[|\]$/g, "").toUpperCase();
  if (!documentHandle) return null;
  return {
    topic: (typeof r.topic === "string" && clampText(r.topic, MAX_TOPIC)) || "General",
    question,
    purpose: typeof r.purpose === "string" ? clampText(r.purpose, MAX_PURPOSE) || null : null,
    documentHandle,
    quote,
  };
}

/** The page a verified quote sits on, from the document's chunks in order, or null when the
 * chunks carry no page numbers or the quote isn't there. The chunks are searched as one text, so a
 * quote that runs across a page break is found too, and belongs to the page it starts on. */
export function pageOfQuote(chunks: { pageNumber: number | null; text: string }[], quote: string): number | null {
  const q = normalizeForMatch(quote);
  if (!q) return null;
  const starts: number[] = [];
  let joined = "";
  for (const chunk of chunks) {
    if (joined) joined += " ";
    starts.push(joined.length);
    joined += normalizeForMatch(chunk.text);
  }
  const at = joined.indexOf(q);
  if (at < 0) return null;
  let i = starts.length - 1;
  while (i > 0 && starts[i] > at) i -= 1;
  return chunks[i]?.pageNumber ?? null;
}
