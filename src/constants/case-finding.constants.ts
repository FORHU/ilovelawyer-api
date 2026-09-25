import { FindingCategory, FindingTag } from "@prisma/client";

export const AI_FINDING_NOTE = "AI";

/** Which pills a category's rows may carry. Attack/Defense Strategies have none yet. Jev only
 * ever derives CONTESTED/OPEN, MATERIAL/MINOR and STRONG/MODERATE — BRIEFING, RESOLVED and
 * CLOSED are workflow states only the lawyer sets. */
export const FINDING_TAGS_BY_CATEGORY: Record<FindingCategory, readonly FindingTag[]> = {
  LEGAL_ISSUE: ["CONTESTED", "BRIEFING", "OPEN", "RESOLVED"],
  WEAKNESS: ["MATERIAL", "MINOR", "CLOSED"],
  STRENGTH: ["STRONG", "MODERATE"],
  ATTACK_STRATEGY: [],
  DEFENSE_STRATEGY: [],
};

export function isTagAllowed(category: FindingCategory, tag: FindingTag): boolean {
  return FINDING_TAGS_BY_CATEGORY[category].includes(tag);
}

/** Tags only the lawyer sets — never taken from the drafting model or derived by Jev. */
export const WORKFLOW_TAGS: readonly FindingTag[] = ["BRIEFING", "RESOLVED", "CLOSED"];

export function buildCaseFindingPrompt(docs: { id: string; name: string }[]): string {
  const list = docs.map((doc) => `- \`${doc.id}\` — ${doc.name}`).join("\n");

  return `[legal ai]

## ROLE
You are assessing a Philippine case's litigation posture from the attached documents only. You are not writing a memo or citing jurisprudence.

## TASK
From the documents only, identify:
1. Legal issues — the specific legal questions or causes of action actually raised by the facts.
2. Weaknesses — points that hurt this case's persuasive strength (gaps, inconsistencies, unfavorable facts).
3. Strengths — points that help this case's persuasive strength (favorable facts, strong evidence, clear legal support).
4. Attack strategies — concrete affirmative moves to advance this case as the moving/complaining party.
5. Defense strategies — concrete moves to protect this case's position against anticipated challenges.

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
If none: leave the array empty.
`;
}
