import { FindingCategory } from "@prisma/client";
import { parseAiJson } from "./response-parser";
import { stripChatWonderNoise } from "./chat-wonder-noise";

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
const MAX_READINESS_NOTE = 200;

const READINESS_VALUES = new Set(["READY", "DRAFTING", "BLOCKED"]);
// ATTACK_STRATEGY only carries readiness — see case-finding.constants.ts / uk/prompts/case-finding.prompt.ts.
// Defense Strategy tracks something different (an anticipated defense + our answer to it), not readiness.
const READINESS_CATEGORIES = new Set<FindingCategory>(["ATTACK_STRATEGY"]);

export interface ParsedCaseFinding {
  category: FindingCategory;
  label: string;
  sourceLabel: string | null;
  readiness: "READY" | "DRAFTING" | "BLOCKED" | null;
  readinessNote: string | null;
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
    const carriesReadiness = READINESS_CATEGORIES.has(category);
    for (const item of items.slice(0, MAX_ITEMS)) {
      results.push({
        category,
        label: item.label,
        sourceLabel: item.sourceLabel,
        readiness: carriesReadiness ? (item.readiness ?? "DRAFTING") : null,
        readinessNote: carriesReadiness ? item.readinessNote : null,
      });
    }
  }

  return anyTagFound ? results : undefined;
}

interface ParsedItem {
  label: string;
  sourceLabel: string | null;
  readiness: "READY" | "DRAFTING" | "BLOCKED" | null;
  readinessNote: string | null;
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
    return { label: row.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL), sourceLabel: null, readiness: null, readinessNote: null };
  }
  if (row && typeof row === "object" && "label" in row) {
    const r = row as { label: unknown; sourceLabel?: unknown; readiness?: unknown; readinessNote?: unknown };
    const label = String(r.label).replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
    const sourceLabel = typeof r.sourceLabel === "string" ? r.sourceLabel.trim().slice(0, MAX_SOURCE_LABEL) || null : null;
    const readiness =
      typeof r.readiness === "string" && READINESS_VALUES.has(r.readiness.toUpperCase())
        ? (r.readiness.toUpperCase() as "READY" | "DRAFTING" | "BLOCKED")
        : null;
    const readinessNote =
      typeof r.readinessNote === "string" ? r.readinessNote.replace(/\s+/g, " ").trim().slice(0, MAX_READINESS_NOTE) || null : null;
    return { label, sourceLabel, readiness, readinessNote };
  }
  return { label: "", sourceLabel: null, readiness: null, readinessNote: null };
}
