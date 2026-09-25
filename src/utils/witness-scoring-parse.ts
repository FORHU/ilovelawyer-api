import { parseAiJson } from "./response-parser";
import { stripChatWonderNoise } from "./chat-wonder-noise";

export type WitnessStatusValue = "READY" | "ADVERSE" | "OUTSTANDING";

export interface WitnessScoreReason {
  text: string;
  /** The evidence item, contradiction or timeline entry the reason relies on. Null when the model
   * gave none — the UI shows the reason without a source chip rather than inventing one. */
  source: string | null;
}

export interface WitnessScore {
  witnessId: string;
  /** Null when the model said there isn't enough case data to score this witness. */
  credibility: number | null;
  suggestedStatus: WitnessStatusValue | null;
  reasons: WitnessScoreReason[];
}

const MAX_REASONS = 4;
const MAX_TEXT = 400;
const MAX_SOURCE = 200;
const VALID_STATUSES = new Set<string>(["READY", "ADVERSE", "OUTSTANDING"]);

/** `undefined` = no [SCORES] block found/parseable (distinct from an empty array). Only ids in
 * `knownIds` survive, so a hallucinated witness can never create or touch a row. Never throws. */
export function extractWitnessScores(text: string, knownIds: Set<string>): WitnessScore[] | undefined {
  const cleaned = stripChatWonderNoise(text);
  const closed = cleaned.match(/\[SCORES\]([\s\S]*?)\[\/SCORES\]/i);
  let jsonStr = closed ? closed[1].trim() : "";
  if (!jsonStr) {
    const open = cleaned.match(/\[SCORES\]([\s\S]*?)(?:\[(?:\/)?[A-Z_]+\]|$)/i);
    jsonStr = open ? open[1].trim() : "";
  }
  if (!jsonStr) return undefined;

  jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const parsed = parseAiJson(jsonStr);
  if (!Array.isArray(parsed)) return undefined;

  const seen = new Set<string>();
  const results: WitnessScore[] = [];
  for (const row of parsed) {
    const score = normalizeScore(row, knownIds);
    if (score && !seen.has(score.witnessId)) {
      seen.add(score.witnessId);
      results.push(score);
    }
  }
  return results;
}

function normalizeScore(row: unknown, knownIds: Set<string>): WitnessScore | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;

  const witnessId = typeof r.witnessId === "string" ? r.witnessId.trim() : "";
  if (!knownIds.has(witnessId)) return null;

  const rawCredibility = typeof r.credibility === "number" ? r.credibility : Number(r.credibility);
  const credibility =
    r.credibility === null || r.credibility === undefined || !Number.isFinite(rawCredibility)
      ? null
      : Math.min(100, Math.max(0, Math.round(rawCredibility)));

  const statusRaw = typeof r.suggestedStatus === "string" ? r.suggestedStatus.trim().toUpperCase() : "";
  const suggestedStatus = VALID_STATUSES.has(statusRaw) ? (statusRaw as WitnessStatusValue) : null;

  const reasons: WitnessScoreReason[] = [];
  if (Array.isArray(r.reasons)) {
    for (const item of r.reasons.slice(0, MAX_REASONS)) {
      if (!item || typeof item !== "object") continue;
      const ir = item as Record<string, unknown>;
      const text = typeof ir.text === "string" ? ir.text.trim().slice(0, MAX_TEXT) : "";
      if (!text) continue;
      const source = typeof ir.source === "string" ? ir.source.trim().slice(0, MAX_SOURCE) || null : null;
      reasons.push({ text, source });
    }
  }

  return { witnessId, credibility, suggestedStatus, reasons };
}
