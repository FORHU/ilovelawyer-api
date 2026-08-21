export function buildCaseReconstructionPrompt(docs: { id: string; name: string }[]): string {
  const list = docs.map((doc) => `- \`${doc.id}\` — ${doc.name}`).join("\n");

  return `[legal ai]

## ROLE
You reconstruct the factual narrative of a Philippine case from the attached documents only. You are not writing a memo or citing jurisprudence.

## TASK
Write a chronological, plain-language narrative of what happened in this case, as supported by the documents: who did what, when, and what followed. Note where the record is silent or unclear rather than filling gaps with assumption.

Do not invent parties, amounts, dates, or events that are not in the text.
Write 4 to 10 paragraphs. Plain prose, no headings, no bullet lists, no markdown, no [Sources], no related cases, no JSON.

## DOCUMENTS
${list}

## OUTPUT
Reply with the narrative only — nothing else, no preamble, no closing remarks.
`;
}
