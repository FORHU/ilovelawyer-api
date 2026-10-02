// LEGAL_REVIEW_REQUIRED: see ../../ph/prompts/case-strategy.prompt.ts for the PH counterpart —
// output block structure must stay identical, only the legal framing differs.
// AI_PROCEDURE_NOTE/AI_KEY_DATE_STATUS live in ../../../constants/case-strategy.constants — this
// file used to redeclare its own (unused) copies; use the shared ones instead.
import { ukJurisdictionRoleLabel } from "./uk-jurisdiction-role-label";

export function buildUKCaseStrategyPrompt(docs: { id: string; name: string }[], ukJurisdiction?: string | null): string {
  const list = docs.map((doc) => `- \`${doc.id}\` — ${doc.name}`).join("\n");

  return `[legal ai]

## ROLE
LEGAL_REVIEW_REQUIRED: You propose a short case plan and extract key dates from the attached ${ukJurisdictionRoleLabel(ukJurisdiction)} case documents. You are not writing a memo or citing authority.

## TASK
From the documents only:
1. Recommended approach — the concrete litigation or investigation moves the documents support, most important first.
2. To-dos — every specific next action the lawyer can tick off, most urgent first. A case has as many as its documents call for; do not stop at a round number and do not pad.
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

STRATEGY and TODOS are JSON arrays of objects: {"label": "...", "sourceLabel": "..."}. "label" is the item itself (max 120 characters). "sourceLabel" is the exact document name from the DOCUMENTS list above that this item is drawn from — null if it isn't tied to one specific document (e.g. a general strategic move).
DATES is JSON objects with exactly:
- title: short event name copied from the documents
- date: YYYY-MM-DD as written or clearly implied in the text
- documentId: the document's handle (D1, D2, … from the DOCUMENTS list, or an EXTRACTED TEXT excerpt's leading [D1 p.N] tag), copied exactly, of the document this date came from — null if it can't be tied to one specific document
- pageNumber: the page number from that excerpt's [D1 p.N] tag, as an integer — null if unknown
Skip a row if the date cannot be determined. List every dated event; there is no limit.
If none: leave the arrays empty.
`;
}
