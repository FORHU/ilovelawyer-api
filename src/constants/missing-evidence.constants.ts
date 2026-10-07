/** Marks a CaseMissingEvidence row as AI-authored, so a regeneration can replace it while leaving
 * a lawyer's own rows — and AI rows a lawyer has edited — alone. Mirrors AI_FINDING_NOTE. */
export const AI_MISSING_EVIDENCE_NOTE = "AI";

/** Claims as the prompt lists them: a short handle (C1, C2, …) in place of the 36-character id,
 * for the same reason document handles exist — a long id comes back garbled and stops matching. */
export interface MissingEvidencePromptClaim {
  handle: string;
  title: string;
}

/**
 * What the case's own documents don't yet establish. One builder for both tenants
 * (prompt-registry maps PH and UK to it): the question — which facts a pleaded claim rests on
 * that no document proves — is the same whichever jurisdiction the case sits in, and nothing in
 * it states a rule of law. `caseArticle` carries the only jurisdiction-specific wording and sits
 * in front of "case" — "this", or ukJurisdictionRoleLabel's "an England & Wales".
 */
export function buildMissingEvidencePromptBody(
  docs: { id: string; name: string }[],
  claims: MissingEvidencePromptClaim[],
  caseArticle: string,
): string {
  const docList = docs.map((doc) => `- \`${doc.id}\` — ${doc.name}`).join("\n");
  const claimList = claims.length
    ? claims.map((claim) => `- \`${claim.handle}\` — ${claim.title}`).join("\n")
    : "(no claims recorded yet — every gap is case-wide)";

  return `[legal ai]

## ROLE
You are reading ${caseArticle} case's own documents to find what they do not establish. You are not assessing the merits, writing a memo, or citing authority.

## TASK
Identify the evidence this case still needs: the specific facts a claim depends on that no document in the bundle actually proves. For each gap, name what would close it.

A gap is only a gap when the documents are silent or incomplete on something the case needs. Do not list:
- facts the documents already establish, even weakly or in passing,
- two documents disagreeing with each other — that is a contradiction, not a gap,
- evidence that would merely be nice to have, with nothing resting on it.

Do not invent parties, amounts, dates, or claims that are not in the text.

## CLAIMS
${claimList}

## DOCUMENTS
${docList}

## OUTPUT
Reply with this one block and nothing else. No markdown, no [Sources], no related cases.

[MISSING_EVIDENCE]
[]
[/MISSING_EVIDENCE]

A JSON array of objects, at most 10, each carrying:
- "label": what is missing, as a noun phrase (max 160 characters) — e.g. "No signed copy of the 14 March variation".
- "detail": what it would establish and why the case needs it, in one line (max 300 characters). null when the documents don't support saying.
- "suggestedSource": the document, record or witness that would close the gap (max 200 characters) — e.g. "The countersigned variation held by the contractor". null when nothing specific would.
- "claim": the handle from the CLAIMS list above (e.g. "C2"), copied exactly, of the claim this gap belongs to — null for a case-wide gap, or when no claims are listed.
- "severity": "CRITICAL" when an element of a claim fails without it, "MODERATE" when it weakens the claim but the claim survives, "MINOR" when it is a loose end.
If the documents leave nothing material unproven: reply with the empty array.
`;
}
