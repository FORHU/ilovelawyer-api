export interface DamagesExtractPromptData {
  caseName: string;
  actionType?: string | null;
  jurisdiction?: string | null;
  /** UK tenant only — see RedTeamPromptData.ukJurisdiction. */
  ukJurisdiction?: string | null;
  /** Entries already on the case ("DAMAGE — Backwages: 486000", "REMEDY — Reinstatement"), so the
   * model doesn't propose them again. */
  existingHeads: string[];
  /** Each document under its handle (D1, D2, …) as `id` — see case-document-handles.ts. */
  documents: { id: string; name: string; text: string }[];
}

function documentsBlock(documents: DamagesExtractPromptData["documents"]): string {
  return documents.map((d) => `--- DOCUMENT ${d.id} | name: ${d.name} ---\n${d.text || "(no indexed text)"}`).join("\n\n");
}

const OUTPUT_FORMAT = `[DAMAGES]
[{"kind":"DAMAGE","title":"...","description":null,"amount":null,"calculation":null,"estimate":null,"quotes":[{"documentId":"D1","quote":"..."}]}]
[/DAMAGES]`;

const ENTRY_RULES = `For each entry:
- "kind" is "DAMAGE" or "REMEDY".
- "title" is a short name (e.g. "Notice pay", "Moral damages", "Reinstatement").
- "description" is one sentence on what it is for, from the documents, or null.
- "quotes" is 1 to 3 lines, each {"documentId": "<handle, e.g. D1>", "quote": "..."}, copied character-for-character from that document's text (10-300 characters each). Together they must contain every number the entry uses. Each one is checked against its document, and an entry with a quote that cannot be found there is discarded.
- "amount" is a total a quote states for the entry, written without currency signs or thousands separators (200000, not "P200,000.00"), or null.
- "calculation" is for an amount the documents give the inputs for but not the total — a pay rate and a number of days, weeks, months or years (e.g. "12 weeks' notice" and "£450 a week"): {"rate": 450, "count": 12, "unit": "week"}, with both numbers in the quotes. Leave "amount" null then; it is worked out from the calculation. Otherwise null. Never multiply or add up a figure yourself.
- "estimate" is required for every DAMAGE whose documents give neither an amount nor a calculation: {"amount": <your best figure, a single number>, "basis": "<one sentence on how you reached it — the usual range for this head and why this point in it, or the pay and period you assumed and why>"}. It is shown to the lawyer as an AI estimate to review and edit, never as a figure from the documents, so you may use your knowledge of usual awards here. Base it on the facts the documents give (pay, length of service, what happened). Leave "estimate" null when there is an amount or a calculation, and for every REMEDY.`;

/** Everything after the tenant-specific opening — shared by the PH and UK builders so the output
 * contract ([DAMAGES] block, parsed by damages-extract-parse.ts) can never drift between them. */
export function renderDamagesExtractBody(data: DamagesExtractPromptData): string {
  const existing = data.existingHeads.length ? data.existingHeads.map((h) => `- ${h}`).join("\n") : "(none)";
  return `ALREADY IN THE LIST:
${existing}

DOCUMENTS:
${documentsBlock(data.documents)}

INSTRUCTIONS:
Use ONLY the document text above for the claims, quotes, amounts and calculations; your own knowledge is allowed only in an "estimate".
List each damage or remedy this case asks for or could ask for:
- a DAMAGE is money the client is owed (e.g. "P200,000.00 as moral damages", notice pay, an award for injury to feelings);
- a REMEDY is any other order the case asks for (e.g. reinstatement, an apology, a declaration), usually with no amount.
Include the heads each claim in the documents brings, even when no figure is given for them yet: quote the line that makes the claim, leave "amount" and "calculation" null, and give an "estimate". Use the list of usual heads above to know what a claim brings, but only for claims the documents actually make.
${ENTRY_RULES}
One entry per damage or remedy. Do not repeat entries already in the list.
If the documents make no claim, return an empty array.

Respond with the machine-readable block below and nothing else, exactly in this format:
${OUTPUT_FORMAT}`;
}

export function buildDamagesExtractPrompt(data: DamagesExtractPromptData): string {
  return `You are listing the damages and remedies for a litigation team in the Philippines. Case: ${data.caseName}${
    data.actionType ? ` (${data.actionType})` : ""
  }${data.jurisdiction ? `, venue: ${data.jurisdiction}` : ""}.
Damages here include actual or compensatory damages (backwages, unpaid wages), moral and exemplary damages, attorney's fees, and statutory benefits such as 13th month pay, service incentive leave and separation pay. Remedies include reinstatement.
Usual heads by claim: illegal dismissal — backwages, reinstatement (or separation pay in lieu of it), and attorney's fees; unpaid wages or benefits — the unpaid amounts (wage differentials, 13th month pay, service incentive leave pay); a dismissal done in bad faith — moral and exemplary damages.

${renderDamagesExtractBody(data)}`;
}

export interface DamagesCorrectionPromptData {
  /** Entries the reviewer (Jev) rejected: what was proposed and why it was turned down. */
  rejected: {
    kind: string;
    title: string;
    figure: string;
    quote: string;
    /** The handle of the document the entry first quoted. */
    documentId: string;
    reason: "UNSUPPORTED" | "CONTRADICTED";
  }[];
  /** The documents those heads cite, under their handles, with their text. */
  documents: { id: string; name: string; text: string }[];
}

const CORRECTION_REASONS: Record<DamagesCorrectionPromptData["rejected"][number]["reason"], string> = {
  UNSUPPORTED: "the quoted lines do not state this figure for this entry",
  CONTRADICTED: "the quoted lines state a different figure for this entry",
};

/**
 * The one follow-up question DamagesExtractSvc asks when Jev rejects proposed heads: re-read the
 * cited documents and give the right figure with the lines that state it, or leave the head out.
 * Same [DAMAGES] contract as the first prompt, so the same parser and checks apply to the answer.
 */
export function buildDamagesCorrectionPrompt(data: DamagesCorrectionPromptData): string {
  const rejected = data.rejected
    .map(
      (r) =>
        `- ${r.kind} (${r.title}): ${r.figure}, from document ${r.documentId}, quoted as "${r.quote}" — rejected because ${CORRECTION_REASONS[r.reason]}.`,
    )
    .join("\n");
  return `A reviewer checked these proposed damages entries against the lines they were quoted from and rejected them:
${rejected}

DOCUMENTS:
${documentsBlock(data.documents)}

INSTRUCTIONS:
Use ONLY the document text above. For each rejected entry, re-read the documents and either:
- return the entry again with the correct figure and quotes that state it; or
- return it with "amount" and "calculation" null and an "estimate", quoting the line that makes the claim, if no line states a figure for it; or
- leave it out if the documents do not make this claim.
Return only entries from the list above, with the same kind and title.
${ENTRY_RULES}

Respond with the machine-readable block below and nothing else, exactly in this format:
${OUTPUT_FORMAT}`;
}

export interface DamagesEstimatePromptData {
  caseName: string;
  /** "England and Wales" / "the Philippines" — what the usual awards are judged against. */
  venue: string;
  /** Damages with no figure yet: the title and the line that makes the claim. */
  heads: { title: string; description: string | null; quote: string | null }[];
  /** The batch's documents under their handles, for the facts an estimate rests on. */
  documents: { id: string; name: string; text: string }[];
}

/**
 * The follow-up question DamagesExtractSvc asks for every damage still without an amount: one best
 * figure each, with a sentence on how it was reached. Every AI damage then carries a figure for the
 * lawyer to check and edit; the panel shows each one as an AI estimate.
 */
export function buildDamagesEstimatePrompt(data: DamagesEstimatePromptData): string {
  const heads = data.heads
    .map((h) => `- ${h.title}${h.description ? ` — ${h.description}` : ""}${h.quote ? ` (claimed in: "${h.quote}")` : ""}`)
    .join("\n");
  return `You are estimating damages for a litigation team in ${data.venue}. Case: ${data.caseName}.
These damages are claimed but no document states a figure for them:
${heads}

DOCUMENTS:
${documentsBlock(data.documents)}

INSTRUCTIONS:
Give one best estimate for EVERY damage above — none may be left out. Base it on the facts the documents give (pay, length of service, age, what happened, how long it lasted) and on the usual awards for that head in ${data.venue}. Where a fact you need is missing, assume a typical value and say so.
For each: "title" copied exactly from the list, "amount" a single number without currency signs or thousands separators, and "basis" one sentence on how you reached it (the usual range and why this point in it, or the pay and period assumed). Each is shown to the lawyer as an AI estimate to review and edit.

Respond with the machine-readable block below and nothing else, exactly in this format:
[ESTIMATES]
[{"title":"...","amount":0,"basis":"..."}]
[/ESTIMATES]`;
}
