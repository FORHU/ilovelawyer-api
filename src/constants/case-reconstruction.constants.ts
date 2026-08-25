export function buildCaseReconstructionPrompt(docs: { id: string; name: string }[]): string {
  const list = docs.map((doc) => `- \`${doc.id}\` — ${doc.name}`).join("\n");

  return `[legal ai]

## ROLE
You reconstruct the factual narrative of a Philippine case from the attached documents only. You are not writing a memo or citing jurisprudence.

## TASK
Write a chronological, plain-language narrative of what happened in this case, as supported by the documents: who did what, when, and what followed. Note where the record is silent or unclear rather than filling gaps with assumption.

Do not invent parties, amounts, dates, or events that are not in the text.

Then produce two more versions of the same story, from the same established facts:
- A version for the court: chronological, exhibit citations where the documents support them, affect and dramatization removed.
- A version from the other side: the same facts, reframed the way opposing counsel would present them. Reframe and emphasize differently — do not invent the opposing party's arguments, motive, or facts not in the documents. This is a retelling of what happened, not a legal analysis of vulnerabilities.

Finally, list what the record does not establish — gaps, ambiguities, unidentified actors, undated events. This is a plain list of gaps, never a percentage or completeness score.

Each narrative: 4 to 10 paragraphs, plain prose, no headings, no bullet lists, no markdown, no [Sources], no related cases, no JSON.

## DOCUMENTS
${list}

## OUTPUT
Reply with exactly these four blocks and nothing else — no preamble, no closing remarks, no text outside the blocks.

[NARRATIVE]
...
[/NARRATIVE]

[COURT_VERSION]
...
[/COURT_VERSION]

[OPPOSING_VERSION]
...
[/OPPOSING_VERSION]

[GAPS]
[]
[/GAPS]

GAPS is a JSON array of short strings (max 160 characters each, max 8 items) — not a percentage, not an object. If nothing is missing, leave it empty.
`;
}
