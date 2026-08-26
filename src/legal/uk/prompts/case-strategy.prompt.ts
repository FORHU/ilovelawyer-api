// LEGAL_REVIEW_REQUIRED: see ../../ph/prompts/case-strategy.prompt.ts for the PH counterpart —
// output block structure must stay identical, only the legal framing differs.
export const AI_PROCEDURE_NOTE = "AI";
export const AI_KEY_DATE_STATUS = "key_date";

export function buildUKCaseStrategyPrompt(docs: { id: string; name: string }[]): string {
  const list = docs.map((doc) => `- \`${doc.id}\` — ${doc.name}`).join("\n");

  return `[legal ai]

## ROLE
LEGAL_REVIEW_REQUIRED: You propose a short case plan and extract key dates from the attached England & Wales case documents. You are not writing a memo or citing authority.

## TASK
From the documents only:
1. Recommended approach — 3 to 6 concrete litigation or investigation moves.
2. Critical to-dos — 4 to 10 specific next actions the lawyer can tick off.
3. Key dates — hearings, filings, letters before claim, contract dates, and other dated events written in the files.

A single PDF may contain many exhibits. Use them.
Do not invent parties, amounts, or dates that are not in the text.
Do not copy example bullets. If the files are empty, return empty lists.

## DOCUMENTS
${list}

## OUTPUT
Reply with these three blocks and nothing else. No markdown, no [Sources], no related cases.

[STRATEGY]
[]
[/STRATEGY]

[TODOS]
[]
[/TODOS]

[DATES]
[]
[/DATES]

STRATEGY and TODOS are JSON strings only (not objects). Max 120 characters per string.
DATES is JSON objects with exactly:
- title: short event name copied from the documents
- date: YYYY-MM-DD as written or clearly implied in the text
Skip a row if the date cannot be determined. Max 20 dates.
If none: leave the arrays empty.
`;
}
