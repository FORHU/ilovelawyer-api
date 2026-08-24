import { parseAiJson } from "./response-parser";

const MAX_GAPS = 8;
const MAX_GAP_LABEL = 160;

function stripChatWonderNoise(text: string): string {
  return text
    .replace(/__END__$/g, "")
    .replace(/\[Sources\][\s\S]*$/i, "")
    .replace(/\[RELATED_QUERIES\][\s\S]*?\[\/RELATED_QUERIES\]/gi, "")
    .replace(/\[RELATED_CASES\][\s\S]*$/i, "")
    .trim();
}

/** Extracts the raw prose between `[TAG]...[/TAG]` (or, if unclosed, up to the next
 * `[SOME_TAG]`/end of string — same fallback shape as case-finding-parse.ts's
 * extractStringList). Returns the trimmed text, or undefined if the tag isn't present. */
function extractTaggedText(text: string, tag: string): string | undefined {
  const closedRe = new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`, "i");
  const closed = text.match(closedRe);
  if (closed) return closed[1].trim() || undefined;

  const openRe = new RegExp(`\\[${tag}\\]([\\s\\S]*?)(?:\\[(?:\\/)?[A-Z_]+\\]|$)`, "i");
  const open = text.match(openRe);
  return open ? open[1].trim() || undefined : undefined;
}

export interface ParsedRegisterNarratives {
  narrative: string;
  court: string;
  opposing: string;
}

/** `undefined` = the [NARRATIVE] block itself is missing (old-style unstructured response,
 * or a parse failure) — the one required block, since a general narrative with no registers
 * is still a valid fallback but no narrative at all isn't. Court/opposing default to "" when
 * the model omits them, same "empty means the model produced nothing there" contract as
 * extractCaseFindings' per-category lists. */
export function extractRegisterNarratives(text: string): ParsedRegisterNarratives | undefined {
  const cleaned = stripChatWonderNoise(text);
  const narrative = extractTaggedText(cleaned, "NARRATIVE");
  if (!narrative) return undefined;

  return {
    narrative,
    court: extractTaggedText(cleaned, "COURT_VERSION") ?? "",
    opposing: extractTaggedText(cleaned, "OPPOSING_VERSION") ?? "",
  };
}

/** `undefined` = the [GAPS] block is missing/unparseable. Empty array = the model
 * explicitly found nothing missing. Mirrors extractCaseStrategy/extractCaseFindings' contract. */
export function extractReconstructionGaps(text: string): string[] | undefined {
  const cleaned = stripChatWonderNoise(text);
  const raw = extractTaggedText(cleaned, "GAPS");
  if (raw === undefined) return undefined;

  const jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const parsed = parseAiJson(jsonStr);
  if (!Array.isArray(parsed)) return undefined;

  const gaps: string[] = [];
  const seen = new Set<string>();
  for (const row of parsed) {
    if (typeof row !== "string") continue;
    const label = row.replace(/\s+/g, " ").trim().slice(0, MAX_GAP_LABEL);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    gaps.push(label);
  }
  return gaps.slice(0, MAX_GAPS);
}
