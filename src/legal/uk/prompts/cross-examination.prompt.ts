// Shares the PH body (../../../constants/cross-examination.constants): leading, one-fact questions
// put to the other side's witness are the same technique in both, and the prompt states no rule
// of law. Only the role line differs.
import { buildCrossExaminationPromptBody, CrossExamPromptInput } from "../../../constants/cross-examination.constants";
import { ukJurisdictionRoleLabel } from "./uk-jurisdiction-role-label";

export function buildUKCrossExaminationPrompt(input: CrossExamPromptInput, ukJurisdiction?: string | null): string {
  return buildCrossExaminationPromptBody(input, ukJurisdictionRoleLabel(ukJurisdiction));
}
