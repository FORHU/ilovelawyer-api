// LEGAL_REVIEW_REQUIRED: see ../../uk/prompts/case-outlook.prompt.ts for the UK counterpart —
// material and output contract are shared (../../prompts/case-outlook-inputs.ts), only the
// framing differs.
import { CaseOutlookPromptInput, caseOutlookOutputContract, formatCaseOutlookMaterial } from "../../prompts/case-outlook-inputs";

export function buildCaseOutlookPrompt(input: CaseOutlookPromptInput): string {
  return `[legal ai]

## ROLE
LEGAL_REVIEW_REQUIRED: You are giving a cautious overall outlook for a Philippine case, from the petitioner/plaintiff's side, based only on the attached documents and the case material below. You are not writing a memo or citing jurisprudence.

## TASK
Weigh how the case currently stands for the petitioner/plaintiff against the respondent/defendant. Base it on the documents, findings, open risks, contradictions and deadlines below. Do not invent parties, amounts, or facts that are not in the material.

${formatCaseOutlookMaterial(input)}

${caseOutlookOutputContract(input.language)}
`;
}
