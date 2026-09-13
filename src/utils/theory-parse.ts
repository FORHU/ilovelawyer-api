import { parseAiJson } from "./response-parser";
import { stripChatWonderNoise } from "./chat-wonder-noise";

const MAX_CLAIMS = 12;
const MAX_ASSUMPTIONS = 8;
const MAX_OPEN_QUESTIONS = 8;
const MAX_DIVERGENT = 10;
const MAX_STATEMENT_CHARS = 500;

/** Same closed-tag-then-open-tag-fallback shape as case-reconstruction-parse.ts's
 * extractTaggedText, duplicated locally rather than shared — the two modules parse
 * structurally different payloads (JSON here, prose there) and have no other overlap. */
function extractTaggedJson(text: string, tag: string): unknown {
  const cleaned = stripChatWonderNoise(text);
  const closedRe = new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`, "i");
  const closed = cleaned.match(closedRe);
  const openRe = new RegExp(`\\[${tag}\\]([\\s\\S]*?)(?:\\[(?:\\/)?[A-Z_]+\\]|$)`, "i");
  const raw = closed ? closed[1] : cleaned.match(openRe)?.[1];
  if (!raw) return undefined;
  const jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  return parseAiJson(jsonStr);
}

function trimmedString(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim().slice(0, maxLen);
  return trimmed || undefined;
}

export interface ParsedTheoryProposal {
  title: string;
  thesis: string;
  claims: { statement: string; stance: "ASSERTS" | "DENIES" }[];
  assumptions: string[];
  openQuestions: string[];
}

/** `undefined` = the [THEORY_PROPOSAL] block is missing, unparseable, or lacks the two required
 * fields (title, thesis) — CaseTheorySvc.propose treats that as "chat-wonder returned nothing
 * usable" rather than shipping a half-formed draft. */
export function parseTheoryProposal(text: string): ParsedTheoryProposal | undefined {
  const parsed = extractTaggedJson(text, "THEORY_PROPOSAL");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;

  const title = trimmedString(obj.title, 200);
  const thesis = trimmedString(obj.thesis, 4000);
  if (!title || !thesis) return undefined;

  const claims: ParsedTheoryProposal["claims"] = [];
  if (Array.isArray(obj.claims)) {
    for (const raw of obj.claims) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const statement = trimmedString(r.statement, MAX_STATEMENT_CHARS);
      const stance = r.stance === "DENIES" ? "DENIES" : r.stance === "ASSERTS" ? "ASSERTS" : undefined;
      if (!statement || !stance) continue;
      claims.push({ statement, stance });
      if (claims.length >= MAX_CLAIMS) break;
    }
  }

  const assumptions = Array.isArray(obj.assumptions)
    ? obj.assumptions.map((a) => trimmedString(a, MAX_STATEMENT_CHARS)).filter((s): s is string => !!s).slice(0, MAX_ASSUMPTIONS)
    : [];
  const openQuestions = Array.isArray(obj.openQuestions)
    ? obj.openQuestions.map((q) => trimmedString(q, MAX_STATEMENT_CHARS)).filter((s): s is string => !!s).slice(0, MAX_OPEN_QUESTIONS)
    : [];

  return { title, thesis, claims, assumptions, openQuestions };
}

export interface TheoryDiffDivergence {
  claimA: string;
  claimB: string;
  decidingEvidence: string;
  missing: string;
}

export interface ParsedTheoryDiff {
  sharedClaims: string[];
  divergentClaims: TheoryDiffDivergence[];
}

/** `undefined` = the [THEORY_DIFF] block is missing or unparseable. An empty result (both
 * arrays length 0) is valid — it means the model found nothing shared and nothing divergent,
 * which TheoryDiffSvc still stores and shows as "no overlap found" rather than treating as a
 * failure, same as extractReconstructionGaps' "explicitly found nothing" contract. */
export function parseTheoryDiff(text: string): ParsedTheoryDiff | undefined {
  const parsed = extractTaggedJson(text, "THEORY_DIFF");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;

  const sharedClaims = Array.isArray(obj.sharedClaims)
    ? obj.sharedClaims.map((c) => trimmedString(c, MAX_STATEMENT_CHARS)).filter((s): s is string => !!s)
    : [];

  const divergentClaims: TheoryDiffDivergence[] = [];
  if (Array.isArray(obj.divergentClaims)) {
    for (const raw of obj.divergentClaims) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const claimA = trimmedString(r.claimA, MAX_STATEMENT_CHARS);
      const claimB = trimmedString(r.claimB, MAX_STATEMENT_CHARS);
      const decidingEvidence = trimmedString(r.decidingEvidence, MAX_STATEMENT_CHARS);
      const missing = trimmedString(r.missing, MAX_STATEMENT_CHARS);
      if (!claimA || !claimB) continue;
      divergentClaims.push({
        claimA,
        claimB,
        decidingEvidence: decidingEvidence ?? "",
        missing: missing ?? "",
      });
      if (divergentClaims.length >= MAX_DIVERGENT) break;
    }
  }

  return { sharedClaims, divergentClaims };
}
