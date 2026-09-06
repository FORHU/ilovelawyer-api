// LEGAL_REVIEW_REQUIRED: see ../../ph/prompts/case-reconstruction.prompt.ts for the PH
// counterpart — output block structure must stay identical, only the legal framing differs.
export function buildUKCaseReconstructionPrompt(docs: { id: string; name: string }[]): string {
  const list = docs.map((doc) => `- \`${doc.id}\` — ${doc.name}`).join("\n");

  return `[legal ai]

## ROLE
LEGAL_REVIEW_REQUIRED: You reconstruct the factual narrative of an England & Wales case from the attached documents only. You are not writing a memo or citing authority.

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

CLAIM ATTRIBUTION
After the four blocks below, also output a [CLAIMS] block: a JSON array classifying the load-bearing sentences of the NARRATIVE (the first block only — not the court or opposing versions), so a lawyer can see at a glance what's drawn directly from a document versus your own inference.

For each entry:
- "text": an exact, verbatim substring copied character-for-character from the NARRATIVE block above — never paraphrase or summarize it. This is matched back against the text, so it must match exactly.
- "category": one of "GROUNDED" (directly stated in one of the documents listed above), "INFERENCE" (a reasonable deduction you made that isn't directly stated), or "UNSUPPORTED" (included for narrative completeness but not actually backed by the documents).
- "sourceLabel": for GROUNDED only, the exact document name from the DOCUMENTS list above that this sentence is drawn from. Null for INFERENCE and UNSUPPORTED.

Cover only load-bearing factual claims — not every sentence (skip connective prose and scene-setting). Cap at 30 entries.

## OUTPUT
Reply with exactly these five blocks and nothing else — no preamble, no closing remarks, no text outside the blocks.

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

[CLAIMS]
[{"text": "...", "category": "GROUNDED", "sourceLabel": "..."}]
[/CLAIMS]

GAPS is a JSON array of short strings (max 160 characters each, max 8 items) — not a percentage, not an object. If nothing is missing, leave it empty.
`;
}
