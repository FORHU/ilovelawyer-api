import { parseAiJson } from "./response-parser";

const MAX_ITEMS = { STRATEGY: 8, TODO: 12, DATES: 20 };
const MAX_LABEL = 160;
const MAX_SOURCE_LABEL = 200;

function stripChatWonderNoise(text: string): string {
  return text
    .replace(/__END__$/g, "")
    .replace(/\[Sources\][\s\S]*$/i, "")
    .replace(/\[RELATED_QUERIES\][\s\S]*?\[\/RELATED_QUERIES\]/gi, "")
    .replace(/\[RELATED_CASES\][\s\S]*$/i, "")
    .replace(/\[CONTRADICTIONS\][\s\S]*?\[\/CONTRADICTIONS\]/gi, "")
    .replace(/\[TIMELINE\][\s\S]*?\[\/TIMELINE\]/gi, "")
    .replace(/\[MINDMAP\][\s\S]*?\[\/MINDMAP\]/gi, "")
    .trim();
}

export interface ParsedKeyDate {
  title: string;
  date: string;
}

export interface ParsedStrategyItem {
  label: string;
  sourceLabel: string | null;
}

export interface ParsedCaseStrategy {
  strategy: ParsedStrategyItem[];
  todos: ParsedStrategyItem[];
  dates: ParsedKeyDate[];
}

/**
 * `undefined` = tagged blocks missing or unparseable.
 * Empty arrays = model found nothing to recommend.
 */
export function extractCaseStrategy(text: string): ParsedCaseStrategy | undefined {
  const cleaned = stripChatWonderNoise(text);
  const strategy = extractItemList(cleaned, "STRATEGY");
  const todos = extractItemList(cleaned, "TODOS");
  const dates = extractDateList(cleaned);
  if (strategy === undefined && todos === undefined && dates === undefined) return undefined;
  return {
    strategy: (strategy ?? []).slice(0, MAX_ITEMS.STRATEGY),
    todos: (todos ?? []).slice(0, MAX_ITEMS.TODO),
    dates: (dates ?? []).slice(0, MAX_ITEMS.DATES),
  };
}

function extractItemList(text: string, tag: string): ParsedStrategyItem[] | undefined {
  const parsed = extractTaggedArray(text, tag);
  if (!parsed) return parsed === undefined ? undefined : [];

  const items: ParsedStrategyItem[] = [];
  const seen = new Set<string>();
  for (const row of parsed) {
    const item = normalizeItem(row);
    if (!item.label || seen.has(item.label.toLowerCase())) continue;
    seen.add(item.label.toLowerCase());
    items.push(item);
  }
  return items;
}

function extractDateList(text: string): ParsedKeyDate[] | undefined {
  const parsed = extractTaggedArray(text, "DATES");
  if (!parsed) return parsed === undefined ? undefined : [];

  const dates: ParsedKeyDate[] = [];
  const seen = new Set<string>();
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const item = row as { title?: unknown; date?: unknown; label?: unknown };
    const title = normalizeLabel(item.title ?? item.label);
    const date = normalizeIsoDate(item.date);
    if (!title || !date) continue;
    const key = `${title.toLowerCase()}|${date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dates.push({ title, date });
  }
  return dates;
}

function extractTaggedArray(text: string, tag: string): unknown[] | undefined | null {
  const re = new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`, "i");
  const closed = text.match(re);
  let jsonStr = "";
  if (closed) {
    jsonStr = closed[1].trim();
  } else {
    const open = text.match(
      new RegExp(
        `\\[${tag}\\]([\\s\\S]*?)(?:\\[(?:\\/)?(?:STRATEGY|TODOS|DATES|CONTRADICTIONS|TIMELINE|MINDMAP|Sources)\\]|$)`,
        "i",
      ),
    );
    if (open) jsonStr = open[1].trim();
  }
  if (!jsonStr) return undefined;

  jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const parsed = parseAiJson(jsonStr);
  if (!Array.isArray(parsed)) return undefined;
  return parsed;
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

function normalizeItem(row: unknown): ParsedStrategyItem {
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

function normalizeIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  const date = new Date(`${match[1]}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return match[1];
}
