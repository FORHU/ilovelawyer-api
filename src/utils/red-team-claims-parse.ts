import { parseAiJson } from "./response-parser";
import { stripChatWonderNoise } from "./chat-wonder-noise";

export type RedTeamClaimCategory = "GROUNDED" | "INFERENCE" | "UNSUPPORTED";

export interface RedTeamClaim {
  /** Verbatim substring of the assessment text — matched back onto it at render time
   * (components/shared/attributed-text.tsx), never stored inline in the assessment itself. */
  text: string;
  category: RedTeamClaimCategory;
  /** Which specific input item (a Weakness bullet, a witness name, ...) this claim is based
   * on — GROUNDED only. Null for INFERENCE/UNSUPPORTED. */
  sourceLabel: string | null;
}

const MAX_ITEMS = 30;
const MAX_TEXT = 500;
const MAX_LABEL = 200;
const VALID_CATEGORIES = new Set<string>(["GROUNDED", "INFERENCE", "UNSUPPORTED"]);

/** `undefined` = no [CLAIMS] block found/parseable — distinct from an empty array, which means
 * the model produced the block but found nothing worth flagging. Mirrors extractCaseFindings'
 * shape/behavior. Never throws; a malformed block just degrades to undefined. */
export function extractRedTeamClaims(text: string): RedTeamClaim[] | undefined {
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

  const results: RedTeamClaim[] = [];
  for (const row of parsed.slice(0, MAX_ITEMS)) {
    const claim = normalizeClaim(row);
    if (claim) results.push(claim);
  }
  return results;
}

function normalizeClaim(row: unknown): RedTeamClaim | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;

  const text = typeof r.text === "string" ? r.text.trim().slice(0, MAX_TEXT) : "";
  if (!text) return null;

  const categoryRaw = typeof r.category === "string" ? r.category.trim().toUpperCase() : "";
  const category = (VALID_CATEGORIES.has(categoryRaw) ? categoryRaw : "UNSUPPORTED") as RedTeamClaimCategory;

  const sourceLabel =
    category === "GROUNDED" && typeof r.sourceLabel === "string"
      ? r.sourceLabel.trim().slice(0, MAX_LABEL) || null
      : null;

  return { text, category, sourceLabel };
}
