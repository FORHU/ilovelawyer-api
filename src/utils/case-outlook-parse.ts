import { ConfidenceLevel, OutlookBand, RiskSeverity } from "@prisma/client";
import { parseAiJson } from "./response-parser";
import { stripChatWonderNoise } from "./chat-wonder-noise";

const TAG = "CASE_OUTLOOK";
const MAX_RATIONALE = 2000;
const MAX_DRIVERS = 6;
const MAX_DRIVER_LABEL = 240;

const BANDS: readonly OutlookBand[] = ["FAVORABLE", "LEANS_FAVORABLE", "UNCERTAIN", "LEANS_UNFAVORABLE", "UNFAVORABLE"];
const CONFIDENCES: readonly ConfidenceLevel[] = ["LOW", "MEDIUM", "HIGH"];

export type OutlookDriverDirection = "HELPS" | "HURTS";

export interface OutlookDriver {
  label: string;
  direction: OutlookDriverDirection;
  sourceDocId?: string;
}

export interface ParsedCaseOutlook {
  band: OutlookBand;
  confidence: ConfidenceLevel;
  rationale: string;
  drivers: OutlookDriver[];
}

/** `undefined` = no usable outlook: no JSON object found, or band / confidence / rationale
 * missing or not one of the allowed values. The caller keeps the previous outlook in that case
 * rather than guessing. Any numeric score or probability the model adds is ignored — only the
 * fields below are ever read. */
export function parseCaseOutlook(text: string): ParsedCaseOutlook | undefined {
  const obj = extractOutlookObject(text);
  if (!obj) return undefined;

  const band = normalizeEnum(obj.band, BANDS);
  const confidence = normalizeEnum(obj.confidence, CONFIDENCES);
  const rationale = trimmed(obj.rationale, MAX_RATIONALE);
  if (!band || !confidence || !rationale) return undefined;

  const drivers: OutlookDriver[] = [];
  if (Array.isArray(obj.drivers)) {
    for (const raw of obj.drivers) {
      const driver = normalizeDriver(raw);
      if (driver) drivers.push(driver);
      if (drivers.length >= MAX_DRIVERS) break;
    }
  }

  return { band, confidence, rationale, drivers };
}

export interface OutlookGuardContext {
  caseDocumentIds: Iterable<string>;
  readyDocumentCount: number;
  openRiskSeverities: RiskSeverity[];
  minReadyDocs: number;
  lowConfidenceRiskSeverities: readonly RiskSeverity[];
}

/** Server-side rules the model is not trusted to follow on its own: a driver's sourceDocId must
 * name a document on this case (otherwise it is dropped, the driver kept), and confidence is
 * forced to LOW on thin evidence. */
export function applyOutlookGuards(outlook: ParsedCaseOutlook, ctx: OutlookGuardContext): ParsedCaseOutlook {
  const docIds = new Set(ctx.caseDocumentIds);
  const drivers = outlook.drivers.map(({ sourceDocId, ...rest }) =>
    sourceDocId && docIds.has(sourceDocId) ? { ...rest, sourceDocId } : rest,
  );

  const thinEvidence =
    ctx.readyDocumentCount < ctx.minReadyDocs ||
    ctx.openRiskSeverities.some((severity) => ctx.lowConfidenceRiskSeverities.includes(severity));

  return { ...outlook, drivers, confidence: thinEvidence ? "LOW" : outlook.confidence };
}

/** Tries, in order: a [CASE_OUTLOOK] block (closed, or left open by a cutoff), then any ```json
 * fence, then the first balanced {...} in the reply — so a reply that wraps the JSON in prose or
 * drops the tag still parses. */
function extractOutlookObject(text: string): Record<string, unknown> | undefined {
  const cleaned = stripChatWonderNoise(text);
  const candidates: string[] = [];

  const closed = cleaned.match(new RegExp(`\\[${TAG}\\]([\\s\\S]*?)\\[\\/${TAG}\\]`, "i"));
  const open = cleaned.match(new RegExp(`\\[${TAG}\\]([\\s\\S]*)$`, "i"));
  if (closed) candidates.push(closed[1]);
  else if (open) candidates.push(open[1]);

  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);

  candidates.push(cleaned);

  for (const candidate of candidates) {
    const obj = firstJsonObject(candidate);
    if (obj) return obj;
  }
  return undefined;
}

function firstJsonObject(text: string): Record<string, unknown> | undefined {
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  for (let start = unfenced.indexOf("{"); start !== -1; start = unfenced.indexOf("{", start + 1)) {
    const end = matchingBrace(unfenced, start);
    if (end === -1) return undefined;
    const parsed = parseAiJson(unfenced.slice(start, end + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if ("band" in obj) return obj;
    }
  }
  return undefined;
}

/** Index of the `}` closing the `{` at `start`, skipping braces inside strings; -1 if unclosed. */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Accepts "leans favourable", "Leans-Favorable" etc. for LEANS_FAVORABLE; anything that doesn't
 * map onto an allowed value is rejected, never coerced to a neighbour. */
function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toUpperCase().replace(/[\s-]+/g, "_").replace(/FAVOURABLE/g, "FAVORABLE");
  return allowed.find((option) => option === key);
}

function normalizeDriver(raw: unknown): OutlookDriver | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const label = trimmed(r.label, MAX_DRIVER_LABEL);
  const direction = normalizeEnum(r.direction, ["HELPS", "HURTS"] as const);
  if (!label || !direction) return undefined;
  const sourceDocId = trimmed(r.sourceDocId, 100);
  return sourceDocId ? { label, direction, sourceDocId } : { label, direction };
}

function trimmed(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.replace(/\s+/g, " ").trim().slice(0, maxLen);
  return result || undefined;
}
