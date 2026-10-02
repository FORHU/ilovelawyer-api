import { renderDamagesExtractBody, DamagesExtractPromptData } from "../../../constants/damages-extract.constants";

// LEGAL_REVIEW_REQUIRED: the examples of UK damages and remedies below are a working list, not a
// jurisdiction-qualified lawyer's view.
export function buildUKDamagesExtractPrompt(data: DamagesExtractPromptData): string {
  const venue = data.ukJurisdiction || "England and Wales";
  return `You are listing the damages and remedies for a litigation team in the United Kingdom (${venue}). Case: ${data.caseName}${
    data.actionType ? ` (${data.actionType})` : ""
  }${data.jurisdiction ? `, venue: ${data.jurisdiction}` : ""}.
Damages here include the compensatory award or damages for financial loss (lost earnings), injury to feelings, aggravated or exemplary damages, costs, the basic award, notice pay and holiday pay. Remedies include reinstatement, re-engagement and declarations.
Usual heads by claim: unfair dismissal (including automatically unfair dismissal) — a basic award and a compensatory award, or reinstatement or re-engagement; discrimination (including disability discrimination) — compensation for injury to feelings and for financial loss, and a declaration; detriment (e.g. whistleblowing) — compensation for injury to feelings and for financial loss; wrongful dismissal — notice pay; unpaid holiday — holiday pay; unlawful deductions from wages — the sums deducted; a redundancy payment where one is claimed.

${renderDamagesExtractBody(data)}`;
}
