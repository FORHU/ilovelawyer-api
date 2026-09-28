import { GroundRole } from "@prisma/client";
import { parseAiJson } from "./response-parser";
import { stripChatWonderNoise } from "./chat-wonder-noise";

export interface ParsedCitationGround {
  citationCheckId: string;
  claimId: string;
  role: GroundRole;
  reason: string | null;
}

const ROLES: readonly GroundRole[] = ["SUBSTANTIVE", "PROCEDURAL"];
const MAX_REASON = 160;

/**
 * `undefined` = no [GROUNDS] block found/parseable (distinct from an empty array, which means the
 * model attached nothing). A link whose citation or claim id wasn't in the prompt, or whose role
 * isn't one of GroundRole, is dropped; a repeated pair keeps its first entry. Never throws.
 */
export function extractCitationGrounds(
  text: string,
  citationIds: Set<string>,
  claimIds: Set<string>,
): ParsedCitationGround[] | undefined {
  const cleaned = stripChatWonderNoise(text);
  const closed = cleaned.match(/\[GROUNDS\]([\s\S]*?)\[\/GROUNDS\]/i);
  let jsonStr = closed ? closed[1].trim() : "";
  if (!jsonStr) {
    const open = cleaned.match(/\[GROUNDS\]([\s\S]*?)(?:\[(?:\/)?[A-Z_]+\]|$)/i);
    jsonStr = open ? open[1].trim() : "";
  }
  if (!jsonStr) return undefined;

  jsonStr = jsonStr.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const parsed = parseAiJson(jsonStr);
  if (!Array.isArray(parsed)) return undefined;

  const seen = new Set<string>();
  const results: ParsedCitationGround[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const citationCheckId = typeof r.citationId === "string" ? r.citationId.trim() : "";
    const claimId = typeof r.claimId === "string" ? r.claimId.trim() : "";
    const role = typeof r.role === "string" ? (r.role.trim().toUpperCase() as GroundRole) : null;
    if (!citationIds.has(citationCheckId) || !claimIds.has(claimId) || !role || !ROLES.includes(role)) continue;
    const key = `${citationCheckId}:${claimId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reason = typeof r.reason === "string" ? r.reason.replace(/\s+/g, " ").trim().slice(0, MAX_REASON) || null : null;
    results.push({ citationCheckId, claimId, role, reason });
  }
  return results;
}
