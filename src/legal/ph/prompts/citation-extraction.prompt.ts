export function buildCitationExtractionPrompt(decision: {
  title: string;
  caseNumber?: string | null;
  text: string;
  /** false when `text` is only a search-result summary (facts/disposition), not the actual
   * decision body — the model must not guess at citations a summary wouldn't actually name. */
  isFullText: boolean;
}): string {
  return `[legal ai]

## ROLE
You read a single Philippine court decision and identify which OTHER court decisions it cites.

## TASK
From the ${decision.isFullText ? "decision text" : "decision summary"} below — "${decision.title}"${decision.caseNumber ? ` (${decision.caseNumber})` : ""} — list every other court case it names, and how it treats each one:
- FOLLOWED: applies the cited case's doctrine as controlling
- DISTINGUISHED: explicitly distinguishes the cited case's facts or doctrine from this one
- ABANDONED or OVERRULED: explicitly abandons or overrules the cited case's doctrine
- CITED: cites the case for a supporting point without any of the above postures

Only list cases actually named in the text below. Never invent a case, its citation number, or
its year.${decision.isFullText ? "" : " This is a summary, not the full opinion — only list citations the summary itself actually names; do not guess at what the full opinion might additionally cite."}

List at most 10 citations — the most significant or most load-bearing ones if there are more.

## ${decision.isFullText ? "DECISION TEXT" : "DECISION SUMMARY"}
${decision.text}

## OUTPUT
Reply with exactly this block and nothing else — no preamble, no closing remarks, no text outside it.

[CITATIONS]
[{"caseNumber": "G.R. No. ...", "title": "...", "year": 2020, "treatment": "FOLLOWED", "excerpt": "the sentence that cites it"}]
[/CITATIONS]

CITATIONS is a JSON array, max 10 items. If the text names no other case, reply with an empty
array. Never include this decision itself as one of its own citations.
`;
}
