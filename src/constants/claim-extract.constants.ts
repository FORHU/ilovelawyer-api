export interface ClaimExtractPromptData {
  caseName: string;
  actionType?: string | null;
  jurisdiction?: string | null;
  /** UK tenant only — see RedTeamPromptData.ukJurisdiction. */
  ukJurisdiction?: string | null;
  /** Claims already on the case, so the model doesn't propose them again. */
  existingClaims: string[];
  documents: { id: string; name: string; text: string }[];
}

/** Everything after the tenant-specific opening line — shared by the PH and UK builders so the
 * output contract ([CLAIMS] block) can never drift between them. */
export function renderClaimExtractBody(data: ClaimExtractPromptData): string {
  const docsText = data.documents
    .map((d) => `--- DOCUMENT id: ${d.id} | name: ${d.name} ---\n${d.text || "(no indexed text)"}`)
    .join("\n\n");
  const existing = data.existingClaims.length ? data.existingClaims.map((c) => `- ${c}`).join("\n") : "(none)";
  return `ALREADY ON THE CLAIMS LIST (do not repeat):
${existing}

DOCUMENTS:
${docsText}

INSTRUCTIONS:
Use ONLY the document text above. Do not use outside knowledge and do not invent claims.
List every claim or cause of action a party actually pleads or asserts in these documents — what the case asks the tribunal to find (e.g. "Illegal dismissal", "Denial of procedural due process", "Unpaid wages", "Unfair dismissal"). Include claims pleaded by either side, such as a counterclaim.
Do not list facts, evidence, defences that only deny a claim, or remedies on their own (damages, reinstatement) — those belong under a claim, not as one.
One entry per claim — merge different wordings of the same claim into one entry.
"title" is the claim's short name (max 80 characters). "causeOfAction" is the legal basis it is pleaded under, as the document states it (e.g. "Labor Code, Art. 294"), or null if the document doesn't say.
"documentId" must be the id of the document the claim is pleaded in. "quote" must be copied character-for-character from that document's text (8-300 characters) and must show the claim being made; it is checked against the document, and an entry whose quote cannot be found is discarded.
If no claim is pleaded, return an empty array.

Respond with the machine-readable block below and nothing else, exactly in this format:
[CLAIMS]
[{"title":"...","causeOfAction":"...","documentId":"<id from above>","quote":"..."}]
[/CLAIMS]`;
}

export function buildClaimExtractPrompt(data: ClaimExtractPromptData): string {
  return `You are identifying the pleaded claims for a litigation team in the Philippines. Case: ${data.caseName}${
    data.actionType ? ` (${data.actionType})` : ""
  }${data.jurisdiction ? `, venue: ${data.jurisdiction}` : ""}.

${renderClaimExtractBody(data)}`;
}
