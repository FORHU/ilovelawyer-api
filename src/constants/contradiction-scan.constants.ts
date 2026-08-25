export const CONTRADICTION_FACT_KEYS = [
  "purchase_price",
  "contract_amount",
  "damages_claimed",
  "deposit_amount",
  "incident_date",
  "contract_date",
  "filing_date",
  "party_plaintiff",
  "party_defendant",
  "other",
] as const

export const CONTRADICTION_KINDS = [
  "amount_mismatch",
  "date_mismatch",
  "party_mismatch",
  "other_mismatch",
] as const

export function buildContradictionPrompt(docs: { id: string; name: string }[]): string {
  const list = docs.map((doc) => `- \`${doc.id}\` — ${doc.name}`).join("\n")

  return `[legal ai]

## ROLE
You extract comparable facts from case documents. You are not advising, citing jurisprudence, or writing a memo.

## TASK
Read only the attached case documents. Find facts that appear in more than one document and disagree.

A contradiction is the SAME fact with DIFFERENT values.
Count it when two sources state a different amount, date, or name for the same event or term.
A single PDF may contain many exhibits, letters, or pleadings — treat those as separate sources even if they share one document id. In that case leftDocumentId and rightDocumentId are the same id, and the two excerpts must be different quotes from different parts of the file.
Do not count different kinds of facts (for example a filing fee vs damages), different events that happen to have dates, captions, headers, page numbers, or boilerplate.

If the files have no usable text, or nothing disagrees, return an empty list.
Do not invent values. Do not copy example numbers. Every value and excerpt must come from the documents.

## DOCUMENTS
${list}

Use these exact ids in leftDocumentId and rightDocumentId.

## FACT KEYS (use only these)
${CONTRADICTION_FACT_KEYS.join(", ")}

Use "other" only if the fact is clearly the same thing in both files and none of the keys fit.

## OUTPUT
Reply with this block and nothing else. No markdown, no [Sources], no related cases, no timeline.

[CONTRADICTIONS]
[]
[/CONTRADICTIONS]

Fill the array with objects that have exactly these fields:
- kind: ${CONTRADICTION_KINDS.join(" | ")}
- factKey: one of the keys above
- leftValue / rightValue: amounts as digits only; dates as YYYY-MM-DD; names trimmed as written
- leftExcerpt / rightExcerpt: ≤200 character quotes copied from the documents, not paraphrased
- leftDocumentId / rightDocumentId: ids from the DOCUMENTS list
- confidence: 0 to 1

If none, leave the array empty: [CONTRADICTIONS][][/CONTRADICTIONS]
`
}
