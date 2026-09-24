// LEGAL_REVIEW_REQUIRED: see ../../ph/prompts/case-outlook.prompt.ts for the PH counterpart —
// material and output contract are shared (../../prompts/case-outlook-inputs.ts), only the
// framing differs.
import { CaseOutlookPromptInput, caseOutlookOutputContract, formatCaseOutlookMaterial } from "../../prompts/case-outlook-inputs";
import { ukJurisdictionRoleLabel } from "./uk-jurisdiction-role-label";

/** Scotland's civil courts say pursuer/defender; the rest of the UK says claimant/defendant. */
function ukPartyLabels(ukJurisdiction?: string | null): { moving: string; opposing: string } {
  return ukJurisdiction === "Scotland"
    ? { moving: "pursuer", opposing: "defender" }
    : { moving: "claimant", opposing: "defendant" };
}

export function buildUKCaseOutlookPrompt(input: CaseOutlookPromptInput): string {
  const { moving, opposing } = ukPartyLabels(input.ukJurisdiction);

  return `[legal ai]

## ROLE
LEGAL_REVIEW_REQUIRED: You are giving a cautious overall outlook for ${ukJurisdictionRoleLabel(input.ukJurisdiction)} case, from the ${moving}'s side, based only on the attached documents and the case material below. You are not writing a memo or citing authority.

## TASK
Weigh how the case currently stands for the ${moving} against the ${opposing}. Base it on the documents, findings, open risks, contradictions and deadlines below. Do not invent parties, amounts, or facts that are not in the material.

${formatCaseOutlookMaterial(input)}

${caseOutlookOutputContract(input.language)}
`;
}
