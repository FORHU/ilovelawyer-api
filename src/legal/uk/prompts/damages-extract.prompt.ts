import { renderDamagesExtractBody, DamagesExtractPromptData } from "../../../constants/damages-extract.constants";

// LEGAL_REVIEW_REQUIRED: the examples of UK damages, remedies and criminal-court orders below are
// a working list, not a jurisdiction-qualified lawyer's view.
export function buildUKDamagesExtractPrompt(data: DamagesExtractPromptData): string {
  const venue = data.ukJurisdiction || "England and Wales";
  const opening = `You are listing the damages and remedies for a litigation team in the United Kingdom (${venue}). Case: ${data.caseName}${
    data.actionType ? ` (${data.actionType})` : ""
  }${data.jurisdiction ? `, venue: ${data.jurisdiction}` : ""}.`;
  return `${opening}
${data.criminal ? CRIMINAL_HEADS : CIVIL_AND_EMPLOYMENT_HEADS}

${renderDamagesExtractBody(data)}`;
}

// A criminal court awards no damages to a party: an unfair-dismissal award or a contract claim is
// never a head of a prosecution (the R v Doyle QA run proposed both from a defendant's ACAS
// dispute in the evidence). Only the orders the court itself can make, and only when the documents
// raise them.
const CRIMINAL_HEADS = `This is a criminal prosecution. A criminal court does not award damages to a party, so list only the orders it can make, and only when the documents expressly raise them: a compensation order to a victim (a DAMAGE, for the sum sought), a confiscation order under the Proceeds of Crime Act 2002, a forfeiture or deprivation order, a restitution order, and a prosecution or defendant's costs order. Do not list employment, contract, personal-injury or any other civil heads — not a basic or compensatory award, reinstatement, re-engagement, notice pay, holiday pay or injury to feelings — even when a document mentions such a dispute. If the documents raise none of these orders, return an empty array.`;

const CIVIL_AND_EMPLOYMENT_HEADS = `Damages here include damages for financial loss (lost earnings, the cost of putting a breach right), general damages for pain, suffering and loss of amenity, special damages (expenses to date), injury to feelings, aggravated or exemplary damages, interest and costs; in the employment tribunal also the basic award, the compensatory award, notice pay and holiday pay. Remedies include injunctions, specific performance, declarations, and in the employment tribunal reinstatement and re-engagement.
Usual heads by claim: breach of contract — damages for the loss caused, interest and costs; negligence or personal injury — general and special damages; unfair dismissal (including automatically unfair dismissal) — a basic award and a compensatory award, or reinstatement or re-engagement; discrimination (including disability discrimination) — compensation for injury to feelings and for financial loss, and a declaration; detriment (e.g. whistleblowing) — compensation for injury to feelings and for financial loss; wrongful dismissal — notice pay; unpaid holiday — holiday pay; unlawful deductions from wages — the sums deducted; a redundancy payment where one is claimed.`;
