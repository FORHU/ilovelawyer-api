export interface DamagesExtractPromptData {
  caseName: string;
  actionType?: string | null;
  jurisdiction?: string | null;
  /** UK tenant only — see RedTeamPromptData.ukJurisdiction. */
  ukJurisdiction?: string | null;
  /** Entries already on the case ("DAMAGE — Backwages: 486000", "REMEDY — Reinstatement"), so the
   * model doesn't propose them again. */
  existingHeads: string[];
  documents: { id: string; name: string; text: string }[];
}

/** Everything after the tenant-specific opening — shared by the PH and UK builders so the output
 * contract ([DAMAGES] block, parsed by damages-extract-parse.ts) can never drift between them. */
export function renderDamagesExtractBody(data: DamagesExtractPromptData): string {
  const docsText = data.documents
    .map((d) => `--- DOCUMENT id: ${d.id} | name: ${d.name} ---\n${d.text || "(no indexed text)"}`)
    .join("\n\n");
  const existing = data.existingHeads.length ? data.existingHeads.map((h) => `- ${h}`).join("\n") : "(none)";
  return `ALREADY IN THE LIST:
${existing}

DOCUMENTS:
${docsText}

INSTRUCTIONS:
Use ONLY the document text above. Do not use outside knowledge, do not estimate, and do not invent figures.
List each damage or remedy this case asks for or could ask for, where a document states it:
- a DAMAGE is money the client is owed, with the amount a document states for it (e.g. "P200,000.00 as moral damages", "backwages of P486,000.00");
- a REMEDY is any other order the case asks for (e.g. reinstatement, an apology, a declaration), usually with no amount.
For each entry:
- "kind" is "DAMAGE" or "REMEDY".
- "title" is a short name (e.g. "Backwages", "Moral damages", "Reinstatement").
- "description" is one sentence on what it is for, from the document, or null.
- "amount" is the figure the quote states for it, written without currency signs or thousands separators (200000, not "P200,000.00"), or null when the document states none. Never compute or add up an amount yourself.
- "documentId" is the id of the document it is in. "quote" is copied character-for-character from that document's text (10-300 characters) and contains the amount when there is one; it is checked against the document, and an entry whose quote or amount cannot be found there is discarded.
One entry per damage or remedy. Do not repeat entries already in the list.
If no document states any, return an empty array.

Respond with the machine-readable block below and nothing else, exactly in this format:
[DAMAGES]
[{"kind":"DAMAGE","title":"...","description":null,"amount":0,"documentId":"<id from above>","quote":"..."}]
[/DAMAGES]`;
}

export function buildDamagesExtractPrompt(data: DamagesExtractPromptData): string {
  return `You are listing the damages and remedies for a litigation team in the Philippines. Case: ${data.caseName}${
    data.actionType ? ` (${data.actionType})` : ""
  }${data.jurisdiction ? `, venue: ${data.jurisdiction}` : ""}.
Damages here include actual or compensatory damages (backwages, unpaid wages), moral and exemplary damages, attorney's fees, and statutory benefits such as 13th month pay, service incentive leave and separation pay. Remedies include reinstatement.

${renderDamagesExtractBody(data)}`;
}

export interface DamagesCorrectionPromptData {
  /** Entries the reviewer (Jev) rejected: what was proposed and why it was turned down. */
  rejected: {
    kind: string;
    title: string;
    figure: string;
    quote: string;
    documentId: string;
    reason: "UNSUPPORTED" | "CONTRADICTED";
  }[];
  /** The documents those heads cite, with their text. */
  documents: { id: string; name: string; text: string }[];
}

const CORRECTION_REASONS: Record<DamagesCorrectionPromptData["rejected"][number]["reason"], string> = {
  UNSUPPORTED: "the quoted line does not state this amount for this entry",
  CONTRADICTED: "the quoted line states a different amount for this entry",
};

/**
 * The one follow-up question DamagesExtractSvc asks when Jev rejects proposed heads: re-read the
 * cited document and give the right figure with the line that states it, or leave the head out.
 * Same [DAMAGES] contract as the first prompt, so the same parser and checks apply to the answer.
 */
export function buildDamagesCorrectionPrompt(data: DamagesCorrectionPromptData): string {
  const docsText = data.documents
    .map((d) => `--- DOCUMENT id: ${d.id} | name: ${d.name} ---\n${d.text || "(no indexed text)"}`)
    .join("\n\n");
  const rejected = data.rejected
    .map(
      (r) =>
        `- ${r.kind} (${r.title}): amount ${r.figure}, from document ${r.documentId}, quoted as "${r.quote}" — rejected because ${CORRECTION_REASONS[r.reason]}.`,
    )
    .join("\n");
  return `A reviewer checked these proposed damages entries against the lines they were quoted from and rejected them:
${rejected}

DOCUMENTS:
${docsText}

INSTRUCTIONS:
Use ONLY the document text above. For each rejected entry, re-read its document and either:
- return the entry again with the correct amount and a "quote" copied character-for-character from the document (10-300 characters) that states that amount for that entry; or
- leave it out if no line in the documents states an amount for it.
Return only entries from the list above, with the same kind and title. The "amount" must appear in "quote". Write numbers without currency signs or thousands separators. Never compute or add up an amount yourself.

Respond with the machine-readable block below and nothing else, exactly in this format:
[DAMAGES]
[{"kind":"DAMAGE","title":"...","description":null,"amount":0,"documentId":"<id from above>","quote":"..."}]
[/DAMAGES]`;
}
