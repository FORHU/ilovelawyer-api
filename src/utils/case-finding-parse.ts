import { FindingCategory } from "@prisma/client";
import { parseAiJson } from "./response-parser";

const TAGS: Record<FindingCategory, string> = {
  LEGAL_ISSUE: "LEGAL_ISSUES",
  WEAKNESS: "WEAKNESSES",
  STRENGTH: "STRENGTHS",
  ATTACK_STRATEGY: "ATTACK_STRATEGY",
  DEFENSE_STRATEGY: "DEFENSE_STRATEGY",
};

const MAX_ITEMS = 8;
const MAX_LABEL = 160;

function stripChatWonderNoise(text: string): string {
  return text
    .replace(/__END__$/g, "")
    .replace(/\[Sources\][\s\S]*$/i, "")
    .replace(/\[RELATED_QUERIES\][\s\S]*?\[\/RELATED_QUERIES\]/gi, "")
    .replace(/\[RELATED_CASES\][\s\S]*$/i, "")
    .trim();
}

export interface ParsedCaseFinding {
  category: FindingCategory;
  label: string;
}

/** `undefined` = no tagged blocks found/parseable at all. Empty array = the model found
 * nothing in every category. Mirrors extractCaseStrategy's shape/behavior. */
export function extractCaseFindings(text: string): ParsedCaseFinding[] | undefined {
  const cleaned = stripChatWonderNoise(text);
  const results: ParsedCaseFinding[] = [];
  let anyTagFound = false;

  for (const category of Object.keys(TAGS) as FindingCategory[]) {
    const items = extractStringList(cleaned, TAGS[category]);
    if (items === undefined) continue;
    anyTagFound = true;
    for (const label of items.slice(0, MAX_ITEMS)) {
      results.push({ category, label });
    }
  }

  return anyTagFound ? results : undefined;
}

function extractStringList(text: string, tag: string): string[] | undefined {
  const re = new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`, "i");
  const closed = text.match(re);
  let jsonStr = "";
  if (closed) {
    jsonStr = closed[1].trim();
  } else {
    const open = text.match(
      new RegExp(`\\[${tag}\\]([\\s\\S]*?)(?:\\[(?:\\/)?[A-Z_]+\\]|$)`, "i"),
    );
    if (open) jsonStr = open[1].trim();
  }
  if (!jsonStr) return undefined;

  jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const parsed = parseAiJson(jsonStr);
  if (!Array.isArray(parsed)) return undefined;

  const labels: string[] = [];
  const seen = new Set<string>();
  for (const row of parsed) {
    const label = normalizeLabel(row);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    labels.push(label);
  }
  return labels;
}

function normalizeLabel(row: unknown): string {
  if (typeof row === "string") return row.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
  if (row && typeof row === "object" && "label" in row) {
    return String((row as { label: unknown }).label)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_LABEL);
  }
  return "";
}
