import { renderDamagesExtractBody, DamagesExtractPromptData } from "../../../constants/damages-extract.constants";

// LEGAL_REVIEW_REQUIRED: the mapping of UK remedies onto the five shared categories below is a
// working assumption until the UK heads get their own model (see the damages plan's "UK tenant
// heads" decision), not a jurisdiction-qualified lawyer's view.
export function buildUKDamagesExtractPrompt(data: DamagesExtractPromptData): string {
  const venue = data.ukJurisdiction || "England and Wales";
  return `You are building a damages model for a litigation team in the United Kingdom (${venue}). Case: ${data.caseName}${
    data.actionType ? ` (${data.actionType})` : ""
  }${data.jurisdiction ? `, venue: ${data.jurisdiction}` : ""}.
Categories: ACTUAL (compensatory award or damages for financial loss, including lost earnings), MORAL (injury to feelings), EXEMPLARY (aggravated or exemplary damages), ATTORNEYS_FEES (costs), OTHER (basic award, notice pay, holiday pay, and anything else).

${renderDamagesExtractBody(data)}`;
}
