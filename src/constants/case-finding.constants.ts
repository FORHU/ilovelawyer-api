import { ClientSide, FindingCategory, FindingTag } from "@prisma/client";
import { attackParty, clientSideSection } from "../legal/prompts/client-side.prompt";

export const AI_FINDING_NOTE = "AI";

/** The shape AI findings are generated in. Bump it whenever the prompt starts asking for something
 * the panels depend on: a case stamped with an older version (Case.findingsFormatVersion)
 * regenerates its findings the next time the Terminal loads it (CaseFindingAiSvc.scheduleIfOutdated).
 *   1 — label + sourceLabel (unstamped cases).
 *   2 — status/tag and detail sub-lines (burden on legal issues), with Jev checks when their flags
 *       are on.
 *   3 — Attack/Defense Strategy get status/tag and detail too (readiness / answer-completeness).
 *   4 — regenerated from the full-text excerpt pack (findings saved before it only saw headers),
 *       and from the client's side when Case.clientSide is set.
 */
export const FINDINGS_FORMAT_VERSION = 4;

/** Which pills a category's rows may carry. Jev only ever derives CONTESTED/OPEN,
 * MATERIAL/MINOR, STRONG/MODERATE, READY/DRAFTING/BLOCKED and ANSWERED/PARTIAL/UNANSWERED —
 * BRIEFING, RESOLVED and CLOSED are workflow states only the lawyer sets. */
export const FINDING_TAGS_BY_CATEGORY: Record<FindingCategory, readonly FindingTag[]> = {
  LEGAL_ISSUE: ["CONTESTED", "BRIEFING", "OPEN", "RESOLVED"],
  WEAKNESS: ["MATERIAL", "MINOR", "CLOSED"],
  STRENGTH: ["STRONG", "MODERATE"],
  ATTACK_STRATEGY: ["READY", "DRAFTING", "BLOCKED"],
  DEFENSE_STRATEGY: ["ANSWERED", "PARTIAL", "UNANSWERED"],
};

export function isTagAllowed(category: FindingCategory, tag: FindingTag): boolean {
  return FINDING_TAGS_BY_CATEGORY[category].includes(tag);
}

/** Tags only the lawyer sets — never taken from the drafting model or derived by Jev. */
export const WORKFLOW_TAGS: readonly FindingTag[] = ["BRIEFING", "RESOLVED", "CLOSED"];

// The middle parameter keeps the PH builder call-compatible with buildUKCaseFindingPrompt.
export function buildCaseFindingPrompt(
  docs: { id: string; name: string }[],
  _ukJurisdiction?: string | null,
  clientSide?: ClientSide | null,
): string {
  const list = docs.map((doc) => `- \`${doc.id}\` — ${doc.name}`).join("\n");

  return `[legal ai]

## ROLE
You are assessing a Philippine case's litigation posture from the attached documents only. You are not writing a memo or citing jurisprudence.
${clientSideSection(clientSide)}
## TASK
From the documents only, identify:
1. Legal issues — the specific legal questions or causes of action actually raised by the facts.
2. Weaknesses — points that hurt this case's persuasive strength (gaps, inconsistencies, unfavorable facts).
3. Strengths — points that help this case's persuasive strength (favorable facts, strong evidence, clear legal support).
4. Attack strategies — concrete affirmative moves to advance this case as ${attackParty(clientSide, "the moving/complaining party")}.
5. Defense strategies — the specific defenses the opposing party is likely to raise against this case, and this case's answer to each.

Do not invent parties, amounts, or facts that are not in the text.
Do not copy example bullets. If the files don't support a category, leave it empty.

## DOCUMENTS
${list}

## OUTPUT
Reply with these five blocks and nothing else. No markdown, no [Sources], no related cases.

[LEGAL_ISSUES]
[]
[/LEGAL_ISSUES]

[WEAKNESSES]
[]
[/WEAKNESSES]

[STRENGTHS]
[]
[/STRENGTHS]

[ATTACK_STRATEGY]
[]
[/ATTACK_STRATEGY]

[DEFENSE_STRATEGY]
[]
[/DEFENSE_STRATEGY]

Every block is a JSON array of objects: {"label": "...", "sourceLabel": "..."}. "label" is the finding itself (max 160 characters). "sourceLabel" is the exact document name from the DOCUMENTS list above that this finding is drawn from — null if it isn't tied to one specific document. Max 8 items per block.
[LEGAL_ISSUES] objects also carry three more fields:
- "detail": who bears the burden on this issue and on what, in one line (max 160 characters) — e.g. "Employer bears the burden of proving just cause".
- "burden": which side bears that burden — "CLAIMANT" (the party that brought the case: complainant, petitioner or plaintiff), "RESPONDENT" (the party defending it), "SHARED", or null if the documents don't say enough to tell.
- "status": "CONTESTED" if the documents show the parties taking opposing positions on this issue, otherwise "OPEN".
[WEAKNESSES] objects also carry two more fields:
- "detail": the concrete work that would close this weakness, in one line (max 160 characters) — e.g. "Obtain the certified payroll for 4–8 August". null if nothing in the documents suggests a fix.
- "status": "MATERIAL" if the other side could use it to defeat a claim or an element of one, otherwise "MINOR".
[STRENGTHS] objects also carry two more fields:
- "detail": the document reference (Bates number, exhibit or page) and what it shows, in one line (max 160 characters) — e.g. "NBL-EM-004417 — HR email presumes continuing employment". null if it isn't tied to one document.
- "status": "STRONG" if on its own it could establish a claim or defeat the other side's main defence, otherwise "MODERATE".
[ATTACK_STRATEGY] objects also carry two more fields:
- "detail": one short sentence on why it's ready, what's left to do, or what's missing (max 160 characters).
- "status": "READY" if this move can be used as-is with what's already available; "DRAFTING" if it's a sound direction but still needs work, with nothing specific shown as missing; "BLOCKED" only if the documents explicitly show a specific missing prerequisite (a certification, exhibit, affidavit, or similar) that has to be obtained first — never guess BLOCKED from silence.
[DEFENSE_STRATEGY] objects also carry two more fields:
- "detail": this case's answer to the defense, grounded in the documents, in one line (max 160 characters). null only when nothing rebuts it yet.
- "status": "ANSWERED" if "detail" fully addresses the defense with what the documents show; "PARTIAL" if it addresses part of it but something material is still open; "UNANSWERED" if there is no real rebuttal yet.
If none: leave the array empty.
`;
}
