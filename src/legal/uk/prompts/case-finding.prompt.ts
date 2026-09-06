// LEGAL_REVIEW_REQUIRED: see ../../ph/prompts/case-finding.prompt.ts for the PH counterpart —
// output block structure must stay identical, only the legal framing differs.
// AI_FINDING_NOTE lives in ../../../constants/case-finding.constants — this file used to
// redeclare its own (unused) copy; use the shared one instead.

export function buildUKCaseFindingPrompt(docs: { id: string; name: string }[]): string {
  const list = docs.map((doc) => `- \`${doc.id}\` — ${doc.name}`).join("\n");

  return `[legal ai]

## ROLE
LEGAL_REVIEW_REQUIRED: You are assessing an England & Wales case's litigation posture from the attached documents only. You are not writing a memo or citing authority.

## TASK
From the documents only, identify:
1. Legal issues — the specific legal questions or causes of action actually raised by the facts.
2. Weaknesses — points that hurt this case's persuasive strength (gaps, inconsistencies, unfavorable facts).
3. Strengths — points that help this case's persuasive strength (favorable facts, strong evidence, clear legal support).
4. Attack strategies — concrete affirmative moves to advance this case as the claimant/applicant party.
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
If none: leave the array empty.
`;
}
