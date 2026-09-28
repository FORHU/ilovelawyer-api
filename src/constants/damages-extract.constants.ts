export interface DamagesExtractPromptData {
  caseName: string;
  actionType?: string | null;
  jurisdiction?: string | null;
  /** UK tenant only — see RedTeamPromptData.ukJurisdiction. */
  ukJurisdiction?: string | null;
  /** Heads already on the case ("ACTUAL — Backwages"), so the model doesn't propose them again. */
  existingHeads: string[];
  documents: { id: string; name: string; text: string }[];
}

/** Everything after the tenant-specific opening — shared by the PH and UK builders so the output
 * contract ([DAMAGES] block, parsed by damages-extract-parse.ts) can never drift between them.
 * The model proposes INPUTS (a rate, a period, a fixed figure, a percentage) with the verbatim
 * line they come from; damages-compute.ts does all the arithmetic. */
export function renderDamagesExtractBody(data: DamagesExtractPromptData): string {
  const docsText = data.documents
    .map((d) => `--- DOCUMENT id: ${d.id} | name: ${d.name} ---\n${d.text || "(no indexed text)"}`)
    .join("\n\n");
  const existing = data.existingHeads.length ? data.existingHeads.map((h) => `- ${h}`).join("\n") : "(none)";
  return `ALREADY IN THE DAMAGES MODEL (do not repeat):
${existing}

DOCUMENTS:
${docsText}

INSTRUCTIONS:
Use ONLY the document text above. Do not use outside knowledge, do not estimate, and do not invent figures.
Find each head of damages or monetary relief this case could claim where a document states a figure to build it from:
- a figure a pleading, demand letter or prayer already asks for (e.g. "P200,000.00 as moral damages");
- a wage, salary or other rate that a claim is computed from (e.g. a monthly salary in a payslip or contract, for backwages);
- a percentage asked for (e.g. "attorney's fees equivalent to 10% of the total monetary award").
For each head give its inputs, never a total:
- "basis" is exactly one of:
  {"kind":"FIXED","amount":<number>} for a stated amount;
  {"kind":"RATE_X_PERIOD","monthlyRate":<number>,"months":<number or omit>} for a monthly rate, with "months" only when the same quote states the number of months;
  {"kind":"PERCENT_OF","percent":<number>,"categories":[...]} for a percentage of other heads, listing the categories it is a percentage of.
- Every number in "basis" must appear in "quote". Write numbers without currency signs or thousands separators (200000, not "P200,000.00").
- "documentId" is the id of the document the figure is in. "quote" is copied character-for-character from that document's text (10-300 characters) and contains the figure; it is checked against the document, and an entry whose quote or numbers cannot be found there is discarded.
- "label" is a short name for the head (e.g. "Backwages", "13th month pay", "Moral damages").
- "legalBasis" is the statute or rule the document itself cites for the head, or null. Do not add one the document does not cite.
- "pendingEvidence" names the document that would prove the figure if the one quoted does not (e.g. "payroll certification" when the rate comes from a single payslip), or null.
One entry per head. If no document states a figure for any head, return an empty array.

Respond with the machine-readable block below and nothing else, exactly in this format:
[DAMAGES]
[{"category":"ACTUAL","label":"...","basis":{"kind":"RATE_X_PERIOD","monthlyRate":0},"legalBasis":null,"pendingEvidence":null,"documentId":"<id from above>","quote":"..."}]
[/DAMAGES]`;
}

export function buildDamagesExtractPrompt(data: DamagesExtractPromptData): string {
  return `You are building a damages model for a litigation team in the Philippines. Case: ${data.caseName}${
    data.actionType ? ` (${data.actionType})` : ""
  }${data.jurisdiction ? `, venue: ${data.jurisdiction}` : ""}.
Categories: ACTUAL (actual or compensatory damages, including backwages and unpaid wages), MORAL, EXEMPLARY, ATTORNEYS_FEES, OTHER (statutory benefits such as 13th month pay, service incentive leave, separation pay, and anything else).

${renderDamagesExtractBody(data)}`;
}
