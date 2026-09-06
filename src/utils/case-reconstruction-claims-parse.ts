import { parseAiJson } from "./response-parser";

export type ReconstructionClaimCategory = "GROUNDED" | "INFERENCE" | "UNSUPPORTED";

export interface ReconstructionClaim {
  /** Verbatim substring of `narrative` — matched back onto it at render time
   * (components/shared/attributed-text.tsx), never stored inline in the narrative itself. */
  text: string;
  category: ReconstructionClaimCategory;
  /** Which specific source document this claim is drawn from — GROUNDED only. Null for
   * INFERENCE/UNSUPPORTED. Unlike RedTeamClaim.sourceLabel (a snapshot bullet), this is a
   * document name — the reconstruction prompt's only input is the document excerpt pack. */
  sourceLabel: string | null;
}

const MAX_ITEMS = 30;
const MAX_TEXT = 500;
const MAX_LABEL = 200;
const VALID_CATEGORIES = new Set<string>(["GROUNDED", "INFERENCE", "UNSUPPORTED"]);

function stripChatWonderNoise(text: string): string {
  return text
    .replace(/__END__$/g, "")
    .replace(/\[Sources\][\s\S]*$/i, "")
    .replace(/\[RELATED_QUERIES\][\s\S]*?\[\/RELATED_QUERIES\]/gi, "")
    .replace(/\[RELATED_CASES\][\s\S]*$/i, "")
    .trim();
}

/** `undefined` = no [CLAIMS] block found/parseable — distinct from an empty array, which means
 * the model produced the block but found nothing worth flagging. Mirrors extractRedTeamClaims'
 * shape/behavior exactly. Never throws; a malformed block just degrades to undefined. */
export function extractReconstructionClaims(text: string): ReconstructionClaim[] | undefined {
  const cleaned = stripChatWonderNoise(text);

  const closed = cleaned.match(/\[CLAIMS\]([\s\S]*?)\[\/CLAIMS\]/i);
  let jsonStr = "";
  if (closed) {
    jsonStr = closed[1].trim();
  } else {
    const open = cleaned.match(/\[CLAIMS\]([\s\S]*?)(?:\[(?:\/)?[A-Z_]+\]|$)/i);
    if (open) jsonStr = open[1].trim();
  }
  if (!jsonStr) return undefined;

  jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const parsed = parseAiJson(jsonStr);
  if (!Array.isArray(parsed)) return undefined;

  const results: ReconstructionClaim[] = [];
  for (const row of parsed.slice(0, MAX_ITEMS)) {
    const claim = normalizeClaim(row);
    if (claim) results.push(claim);
  }
  return results;
}

function normalizeClaim(row: unknown): ReconstructionClaim | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;

  const text = typeof r.text === "string" ? r.text.trim().slice(0, MAX_TEXT) : "";
  if (!text) return null;

  const categoryRaw = typeof r.category === "string" ? r.category.trim().toUpperCase() : "";
  const category = (VALID_CATEGORIES.has(categoryRaw) ? categoryRaw : "UNSUPPORTED") as ReconstructionClaimCategory;

  const sourceLabel =
    category === "GROUNDED" && typeof r.sourceLabel === "string"
      ? r.sourceLabel.trim().slice(0, MAX_LABEL) || null
      : null;

  return { text, category, sourceLabel };
}
