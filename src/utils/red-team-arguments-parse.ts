import { parseAiJson } from "./response-parser";
import { stripChatWonderNoise } from "./chat-wonder-noise";
import { normalizeForMatch } from "./witness-extract-parse";

export type RedTeamArgumentStrength = "STRONG" | "MODERATE" | "WEAK";

export type RedTeamSourceKind =
  | "LEGAL_ISSUE"
  | "WEAKNESS"
  | "CONTRADICTION"
  | "TIMELINE"
  | "DOCUMENT"
  | "WITNESS"
  | "DAMAGE"
  | "PARTY";

/** One case item the red-team prompt showed the model — the only things an argument may cite. */
export interface RedTeamSourceItem {
  kind: RedTeamSourceKind;
  label: string;
}

export interface RedTeamArgument {
  title: string;
  gist: string | null;
  strength: RedTeamArgumentStrength;
  /** -10..10; positive = moves the case toward the opponent. */
  impact: number;
  reasoning: string | null;
  /** The case item it rests on, resolved to the item's own label — never the model's wording. */
  source: RedTeamSourceItem;
}

export interface RedTeamArguments {
  opponent: string | null;
  riskOfLoss: number | null;
  /** Highest impact first. */
  arguments: RedTeamArgument[];
}

const MAX_ARGUMENTS = 8;
const MAX_TITLE = 120;
const MAX_GIST = 120;
const MAX_REASONING = 600;
// Shortest label that may match by being contained in the model's source text, and shortest
// model source that may match by being contained in a label — below these a substring hit is
// too likely to be coincidence (a 3-letter name inside an unrelated sentence).
const MIN_CONTAINED_LABEL = 4;
const MIN_CONTAINED_SOURCE = 12;
const VALID_STRENGTHS = new Set<string>(["STRONG", "MODERATE", "WEAK"]);

function clean(text: string): string {
  return normalizeForMatch(text).replace(/^[-*•"'\s]+|["'\s]+$/g, "");
}

/** Resolves the model's `source` to one of `items`: exact match first, then the longest item
 * label contained in the source (the model copied the bullet with its date prefix), then an item
 * containing the source (the model copied part of a long excerpt). Null when nothing matches. */
export function resolveSource(source: string, items: RedTeamSourceItem[]): RedTeamSourceItem | null {
  const s = clean(source);
  if (!s) return null;
  const cleaned = items.map((item) => ({ item, label: clean(item.label) })).filter((c) => c.label);

  const exact = cleaned.find((c) => c.label === s);
  if (exact) return exact.item;

  const contained = cleaned
    .filter((c) => c.label.length >= MIN_CONTAINED_LABEL && s.includes(c.label))
    .sort((a, b) => b.label.length - a.label.length)[0];
  if (contained) return contained.item;

  if (s.length >= MIN_CONTAINED_SOURCE) {
    const containing = cleaned.find((c) => c.label.includes(s));
    if (containing) return containing.item;
  }
  return null;
}

function str(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.trim().slice(0, max) || null : null;
}

function clampInt(value: unknown, min: number, max: number): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : null;
}

/**
 * `undefined` = no [ARGUMENTS] block found/parseable. An argument is kept only if its `source`
 * resolves to one of `items` (see resolveSource) — the panel never shows an attack it can't point
 * back to the case data. `opponent` is kept only if it names one of `partyNames`. Never throws.
 */
export function extractRedTeamArguments(
  text: string,
  items: RedTeamSourceItem[],
  partyNames: string[],
): RedTeamArguments | undefined {
  const cleaned = stripChatWonderNoise(text);
  const closed = cleaned.match(/\[ARGUMENTS\]([\s\S]*?)\[\/ARGUMENTS\]/i);
  let jsonStr = closed ? closed[1].trim() : "";
  if (!jsonStr) {
    const open = cleaned.match(/\[ARGUMENTS\]([\s\S]*?)(?:\[(?:\/)?[A-Z_]+\]|$)/i);
    jsonStr = open ? open[1].trim() : "";
  }
  if (!jsonStr) return undefined;

  jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const parsed = parseAiJson(jsonStr);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const p = parsed as Record<string, unknown>;

  const opponentRaw = str(p.opponent, 200);
  const opponent = opponentRaw
    ? (partyNames.find((name) => clean(name) === clean(opponentRaw)) ?? null)
    : null;

  const seen = new Set<string>();
  const args: RedTeamArgument[] = [];
  for (const row of Array.isArray(p.arguments) ? p.arguments : []) {
    const arg = normalizeArgument(row, items);
    if (!arg) continue;
    const key = clean(arg.title);
    if (seen.has(key)) continue;
    seen.add(key);
    args.push(arg);
  }
  args.sort((a, b) => b.impact - a.impact);

  return { opponent, riskOfLoss: clampInt(p.riskOfLoss, 0, 100), arguments: args.slice(0, MAX_ARGUMENTS) };
}

function normalizeArgument(row: unknown, items: RedTeamSourceItem[]): RedTeamArgument | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;

  const title = str(r.title, MAX_TITLE);
  const strengthRaw = typeof r.strength === "string" ? r.strength.trim().toUpperCase() : "";
  const impact = clampInt(r.impact, -10, 10);
  const sourceText = typeof r.source === "string" ? r.source : "";
  if (!title || !VALID_STRENGTHS.has(strengthRaw) || impact === null) return null;

  const source = resolveSource(sourceText, items);
  if (!source) return null;

  return {
    title,
    gist: str(r.gist, MAX_GIST),
    strength: strengthRaw as RedTeamArgumentStrength,
    impact,
    reasoning: str(r.reasoning, MAX_REASONING),
    source,
  };
}
