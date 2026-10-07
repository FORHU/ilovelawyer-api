import { MissingEvidenceSeverity } from "@prisma/client";
import { parseAiJson } from "./response-parser";
import { stripChatWonderNoise } from "./chat-wonder-noise";
import { clampText } from "./case-finding-parse";

const TAG = "MISSING_EVIDENCE";
const MAX_ITEMS = 10;
const MAX_LABEL = 400;
const MAX_DETAIL = 300;
const MAX_SUGGESTED_SOURCE = 200;

const SEVERITIES: readonly string[] = ["CRITICAL", "MODERATE", "MINOR"] satisfies readonly MissingEvidenceSeverity[];

export interface ParsedMissingEvidence {
  label: string;
  detail: string | null;
  suggestedSource: string | null;
  /** The claim handle the model cited (C1, C2, …) — resolved to a claim id by the caller, which
   * is the only side that knows the handle map. */
  claimHandle: string | null;
  severity: MissingEvidenceSeverity;
}

/** `undefined` = no parseable block at all, so the caller keeps what the case already has. An
 * empty array = the model read the bundle and found nothing material unproven. Mirrors
 * extractCaseFindings' shape. */
export function extractMissingEvidence(text: string): ParsedMissingEvidence[] | undefined {
  const cleaned = stripChatWonderNoise(text);
  const closed = cleaned.match(new RegExp(`\\[${TAG}\\]([\\s\\S]*?)\\[\\/${TAG}\\]`, "i"));
  // An unclosed block (the reply was cut off) still parses up to the next tag or the end.
  const open = closed ? null : cleaned.match(new RegExp(`\\[${TAG}\\]([\\s\\S]*?)(?:\\[(?:\\/)?[A-Z_]+\\]|$)`, "i"));
  const block = (closed ?? open)?.[1]?.trim();
  if (!block) return undefined;

  const parsed = parseAiJson(block.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim());
  if (!Array.isArray(parsed)) return undefined;

  const items: ParsedMissingEvidence[] = [];
  const seen = new Set<string>();
  for (const row of parsed) {
    const item = normalizeItem(row);
    if (!item) continue;
    const key = item.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length === MAX_ITEMS) break;
  }
  return items;
}

function normalizeItem(row: unknown): ParsedMissingEvidence | null {
  if (!row || typeof row !== "object" || !("label" in row)) return null;
  const r = row as { label: unknown; detail?: unknown; suggestedSource?: unknown; claim?: unknown; severity?: unknown };
  const label = clampText(String(r.label), MAX_LABEL);
  if (!label) return null;
  const severityRaw = typeof r.severity === "string" ? r.severity.trim().toUpperCase() : "";
  return {
    label,
    detail: typeof r.detail === "string" ? clampText(r.detail, MAX_DETAIL) || null : null,
    suggestedSource:
      typeof r.suggestedSource === "string" ? clampText(r.suggestedSource, MAX_SUGGESTED_SOURCE) || null : null,
    claimHandle: typeof r.claim === "string" ? r.claim.trim().replace(/^\[|\]$/g, "").toUpperCase() || null : null,
    // An unrecognised or absent severity is the middle one: a gap the model bothered to report
    // shouldn't be dropped, and shouldn't be promoted to CRITICAL on a guess either.
    severity: (SEVERITIES.includes(severityRaw) ? severityRaw : "MODERATE") as MissingEvidenceSeverity,
  };
}
