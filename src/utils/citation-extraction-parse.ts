import { CitationTreatment } from "@prisma/client";
import { parseAiJson } from "./response-parser";
import { stripChatWonderNoise } from "./chat-wonder-noise";

export interface ExtractedCitation {
  caseNumber: string | null;
  title: string | null;
  year: number | null;
  treatment: CitationTreatment;
  excerpt: string | null;
}

const MAX_ITEMS = 10;
const MAX_EXCERPT = 400;
const VALID_TREATMENTS = new Set<string>(["FOLLOWED", "DISTINGUISHED", "ABANDONED", "OVERRULED", "CITED"]);

/** `undefined` = no [CITATIONS] block found/parseable at all — distinct from an empty array,
 * which means the model looked and found nothing. Mirrors extractCaseFindings' shape. */
export function extractCitations(text: string): ExtractedCitation[] | undefined {
  const cleaned = stripChatWonderNoise(text);

  const closed = cleaned.match(/\[CITATIONS\]([\s\S]*?)\[\/CITATIONS\]/i);
  let jsonStr = "";
  if (closed) {
    jsonStr = closed[1].trim();
  } else {
    const open = cleaned.match(/\[CITATIONS\]([\s\S]*?)(?:\[(?:\/)?[A-Z_]+\]|$)/i);
    if (open) jsonStr = open[1].trim();
  }
  if (!jsonStr) return undefined;

  jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const parsed = parseAiJson(jsonStr);
  if (!Array.isArray(parsed)) return undefined;

  const results: ExtractedCitation[] = [];
  for (const row of parsed.slice(0, MAX_ITEMS)) {
    const item = normalizeItem(row);
    if (item) results.push(item);
  }
  return results;
}

function normalizeItem(row: unknown): ExtractedCitation | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;

  const caseNumber = typeof r.caseNumber === "string" ? r.caseNumber.trim().slice(0, 120) || null : null;
  const title = typeof r.title === "string" ? r.title.trim().slice(0, 300) || null : null;
  // Nothing to resolve against the Law corpus or show in the UI without at least one of these.
  if (!caseNumber && !title) return null;

  const yearNum = typeof r.year === "number" ? r.year : Number(r.year);
  const year = Number.isFinite(yearNum) && yearNum > 1900 && yearNum < 2100 ? yearNum : null;

  const treatmentRaw = typeof r.treatment === "string" ? r.treatment.trim().toUpperCase() : "";
  const treatment = (VALID_TREATMENTS.has(treatmentRaw) ? treatmentRaw : "CITED") as CitationTreatment;

  const excerpt =
    typeof r.excerpt === "string" ? r.excerpt.replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT) || null : null;

  return { caseNumber, title, year, treatment, excerpt };
}
