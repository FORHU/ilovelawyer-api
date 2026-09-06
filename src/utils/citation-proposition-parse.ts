import { CitationPropositionType } from "@prisma/client";
import { parseAiJson } from "./response-parser";

export interface ParsedProposition {
  type: CitationPropositionType;
  reasoning: string | null;
}

const MAX_REASONING = 300;

function stripChatWonderNoise(text: string): string {
  return text
    .replace(/__END__$/g, "")
    .replace(/\[Sources\][\s\S]*$/i, "")
    .replace(/\[RELATED_QUERIES\][\s\S]*?\[\/RELATED_QUERIES\]/gi, "")
    .replace(/\[RELATED_CASES\][\s\S]*$/i, "")
    .trim();
}

/** `null` = no [PROPOSITION] block found/parseable, or the model's `type` wasn't recognized —
 * callers should leave propositionType unset rather than guess. The prompt's own UNSUPPORTED
 * option collapses to INFERRED here since CitationPropositionType only has the three values the
 * memo asked for (quoted/paraphrased/inferred) — both mean "not directly stated." */
export function extractProposition(text: string): ParsedProposition | null {
  const cleaned = stripChatWonderNoise(text);

  const closed = cleaned.match(/\[PROPOSITION\]([\s\S]*?)\[\/PROPOSITION\]/i);
  let jsonStr = "";
  if (closed) {
    jsonStr = closed[1].trim();
  } else {
    const open = cleaned.match(/\[PROPOSITION\]([\s\S]*?)(?:\[(?:\/)?[A-Z_]+\]|$)/i);
    if (open) jsonStr = open[1].trim();
  }
  if (!jsonStr) return null;

  jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const parsed = parseAiJson(jsonStr);
  if (!parsed || typeof parsed !== "object") return null;

  const row = parsed as Record<string, unknown>;
  const raw = typeof row.type === "string" ? row.type.trim().toUpperCase() : "";
  const type: CitationPropositionType | null =
    raw === "PARAPHRASED" ? "PARAPHRASED" : raw === "INFERRED" || raw === "UNSUPPORTED" ? "INFERRED" : null;
  if (!type) return null;

  const reasoning = typeof row.reasoning === "string" ? row.reasoning.trim().slice(0, MAX_REASONING) || null : null;
  return { type, reasoning };
}
