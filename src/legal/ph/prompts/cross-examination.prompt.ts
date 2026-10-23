import { buildCrossExaminationPromptBody, CrossExamPromptInput } from "../../../constants/cross-examination.constants";

/** Same signature as the UK builder so prompt-registry's result is callable either way; PH takes
 * no jurisdiction argument of its own. */
export function buildCrossExaminationPrompt(input: CrossExamPromptInput, _ukJurisdiction?: string | null): string {
  return buildCrossExaminationPromptBody(input, "this");
}
