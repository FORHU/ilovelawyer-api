import { FindingCategory, FindingTag } from "@prisma/client";
import { parseAiJson } from "./response-parser";
import { stripChatWonderNoise } from "./chat-wonder-noise";
import { isTagAllowed, WORKFLOW_TAGS } from "../constants";
import { BURDEN_PARTIES, BurdenParty } from "./legal-issue-jev";

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
const MAX_DETAIL = 160;

export interface ParsedCaseFinding {
  category: FindingCategory;
  label: string;
  sourceLabel: string | null;
  /** The row's sub-line (Legal Issues: who bears the burden and why). */
  detail: string | null;
  /** The drafting model's own pill, kept only when it's one the category may use and not one of
   * the lawyer's workflow states (WORKFLOW_TAGS). */
  tag: FindingTag | null;
  /** Legal Issues only: the model's own burden call, which Jev's is compared against. */
  burden: BurdenParty | null;
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
      const status = item.status as FindingTag | null;
      const tag = status && isTagAllowed(category, status) && !WORKFLOW_TAGS.includes(status) ? status : null;
      const burden = category === "LEGAL_ISSUE" ? item.burden : null;
      results.push({ category, label: item.label, sourceLabel: item.sourceLabel, detail: item.detail, tag, burden });
    }
  }

  return anyTagFound ? results : undefined;
}

interface ParsedItem {
  label: string;
  sourceLabel: string | null;
  detail: string | null;
  /** Upper-cased; checked against the category's allowed tags by the caller. */
  status: string | null;
  burden: BurdenParty | null;
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
    return { label: row.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL), sourceLabel: null, detail: null, status: null, burden: null };
  }
  if (row && typeof row === "object" && "label" in row) {
    const r = row as { label: unknown; sourceLabel?: unknown; detail?: unknown; status?: unknown; burden?: unknown };
    const label = String(r.label).replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
    const sourceLabel = typeof r.sourceLabel === "string" ? r.sourceLabel.trim().slice(0, MAX_SOURCE_LABEL) || null : null;
    const detail = typeof r.detail === "string" ? r.detail.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL) || null : null;
    const status = typeof r.status === "string" ? r.status.trim().toUpperCase() || null : null;
    const burdenRaw = typeof r.burden === "string" ? r.burden.trim().toUpperCase() : "";
    // UNCLEAR is Jev's answer, not one the model is asked for — from the model it means no call.
    const burden =
      burdenRaw !== "UNCLEAR" && (BURDEN_PARTIES as readonly string[]).includes(burdenRaw) ? (burdenRaw as BurdenParty) : null;
    return { label, sourceLabel, detail, status, burden };
  }
  return { label: "", sourceLabel: null, detail: null, status: null, burden: null };
}
