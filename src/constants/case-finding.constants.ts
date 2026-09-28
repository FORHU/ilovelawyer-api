export const AI_FINDING_NOTE = "AI";

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

LEGAL_ISSUES, WEAKNESSES, STRENGTHS and DEFENSE_STRATEGY are JSON arrays of {"label": "...", "sourceLabel": "..."}. "label" is the finding itself (max 160 characters). "sourceLabel" is the exact document name from the DOCUMENTS list above that this finding is drawn from — null if it isn't tied to one specific document.

ATTACK_STRATEGY is a JSON array of {"label": "...", "sourceLabel": "...", "readiness": "READY|DRAFTING|BLOCKED", "readinessNote": "..."}. "readiness" is whether this move is usable now: READY if it can be used as-is with what's already available; DRAFTING if it's a sound direction but still needs work, with nothing specific shown as missing; BLOCKED only if the documents explicitly show a specific missing prerequisite (a certification, exhibit, affidavit, or similar) that has to be obtained first — never guess BLOCKED from silence. "readinessNote" is one short sentence explaining the status: what's missing (BLOCKED), what's left to do (DRAFTING), or why it's ready (READY).

Max 8 items per block.
If none: leave the array empty.
`;
}
