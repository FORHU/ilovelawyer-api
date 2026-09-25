export interface WitnessExtractPromptData {
  caseName: string;
  actionType?: string | null;
  jurisdiction?: string | null;
  /** UK tenant only — see RedTeamPromptData.ukJurisdiction. */
  ukJurisdiction?: string | null;
  /** Names already on the case, so the model doesn't propose them again. */
  existingWitnesses: string[];
  documents: { id: string; name: string; text: string }[];
}

/** Everything after the tenant-specific opening line — shared by the PH and UK builders so the
 * output contract ([WITNESSES] block) can never drift between them. */
export function renderWitnessExtractBody(data: WitnessExtractPromptData): string {
  const docsText = data.documents
    .map((d) => `--- DOCUMENT id: ${d.id} | name: ${d.name} ---\n${d.text || "(no indexed text)"}`)
    .join("\n\n");
  const existing = data.existingWitnesses.length ? data.existingWitnesses.map((n) => `- ${n}`).join("\n") : "(none)";
  return `ALREADY ON THE WITNESS LIST (do not repeat):
${existing}

DOCUMENTS:
${docsText}

INSTRUCTIONS:
Use ONLY the document text above. Do not use outside knowledge and do not invent people.
List every natural person who could give evidence about the facts of this case: people who saw, heard, did, signed, received or wrote something relevant, including the parties themselves, affiants, signatories, authors and recipients of correspondence, and people named as present at an event.
Do not list judges, court staff, notaries acting only as notaries, counsel acting only as counsel, or organisations. Do not list someone only mentioned in passing with no connection to the facts.
One entry per person — merge different spellings or forms of the same name into one entry using the fullest form.
"documentId" must be the id of the document the person appears in. "quote" must be copied character-for-character from that document's text (8-200 characters) and must contain the person's name; it is checked against the document, and an entry whose quote cannot be found is discarded.
"role" is a short label (e.g. "Plaintiff", "Eyewitness", "Author of the 3 May email"). "summary" is one sentence on what they can speak to, based only on the text.
If no such person appears, return an empty array.

Respond with the machine-readable block below and nothing else, exactly in this format:
[WITNESSES]
[{"name":"...","role":"...","summary":"...","documentId":"<id from above>","quote":"..."}]
[/WITNESSES]`;
}

export function buildWitnessExtractPrompt(data: WitnessExtractPromptData): string {
  return `You are identifying potential witnesses for a litigation team in the Philippines. Case: ${data.caseName}${
    data.actionType ? ` (${data.actionType})` : ""
  }${data.jurisdiction ? `, venue: ${data.jurisdiction}` : ""}.

${renderWitnessExtractBody(data)}`;
}
