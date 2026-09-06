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
const MAX_SOURCE_LABEL = 200;

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
  sourceLabel: string | null;
}

/** `undefined` = no tagged blocks found/parseable at all. Empty array = the model found
 * nothing in every category. Mirrors extractCaseStrategy's shape/behavior. */
export function extractCaseFindings(text: string): ParsedCaseFinding[] | undefined {
  const cleaned = stripChatWonderNoise(text);
  const results: ParsedCaseFinding[] = [];
  let anyTagFound = false;

  for (const category of Object.keys(TAGS) as FindingCategory[]) {
    const items = extractItemList(cleaned, TAGS[category]);
    if (items === undefined) continue;
    anyTagFound = true;
    for (const item of items.slice(0, MAX_ITEMS)) {
      results.push({ category, label: item.label, sourceLabel: item.sourceLabel });
    }
  }

  return anyTagFound ? results : undefined;
}

interface ParsedItem {
  label: string;
  sourceLabel: string | null;
}

function extractItemList(text: string, tag: string): ParsedItem[] | undefined {
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

  const items: ParsedItem[] = [];
  const seen = new Set<string>();
  for (const row of parsed) {
    const item = normalizeItem(row);
    if (!item.label || seen.has(item.label.toLowerCase())) continue;
    seen.add(item.label.toLowerCase());
    items.push(item);
  }
  return items;
}

function normalizeItem(row: unknown): ParsedItem {
  if (typeof row === "string") {
    return { label: row.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL), sourceLabel: null };
  }
  if (row && typeof row === "object" && "label" in row) {
    const r = row as { label: unknown; sourceLabel?: unknown };
    const label = String(r.label).replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
    const sourceLabel = typeof r.sourceLabel === "string" ? r.sourceLabel.trim().slice(0, MAX_SOURCE_LABEL) || null : null;
    return { label, sourceLabel };
  }
  return { label: "", sourceLabel: null };
}
