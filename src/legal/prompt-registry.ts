import { Jurisdiction } from "../types/jurisdiction";
import HttpError from "../utils/http-error";
import { buildRedTeamPrompt } from "./ph/prompts/red-team.prompt";
import { buildUKRedTeamPrompt } from "./uk/prompts/red-team.prompt";
import { buildCaseFindingPrompt } from "./ph/prompts/case-finding.prompt";
import { buildUKCaseFindingPrompt } from "./uk/prompts/case-finding.prompt";
import { buildCaseReconstructionPrompt } from "./ph/prompts/case-reconstruction.prompt";
import { buildUKCaseReconstructionPrompt } from "./uk/prompts/case-reconstruction.prompt";
import { buildCaseStrategyPrompt } from "./ph/prompts/case-strategy.prompt";
import { buildUKCaseStrategyPrompt } from "./uk/prompts/case-strategy.prompt";
import { PH_SOURCE_ANALYSIS_PROMPT } from "./ph/prompts/legal-source-cache.prompt";
import { UK_SOURCE_ANALYSIS_PROMPT } from "./uk/prompts/legal-source-cache.prompt";
import { buildPHChatTitlePrompt } from "./ph/prompts/chat-title.prompt";
import { buildUKChatTitlePrompt } from "./uk/prompts/chat-title.prompt";

/** Every getter below selects strictly by jurisdiction — never by client input — and throws
 * rather than falling back to another jurisdiction's prompt when unmapped. */

export function getRedTeamPromptBuilder(jurisdiction: Jurisdiction) {
  switch (jurisdiction) {
    case "PH":
      return buildRedTeamPrompt;
    case "UK":
      return buildUKRedTeamPrompt;
    default:
      throw new HttpError(`No red-team prompt builder configured for jurisdiction: ${jurisdiction}`, 501);
  }
}

export function getCaseFindingPromptBuilder(jurisdiction: Jurisdiction) {
  switch (jurisdiction) {
    case "PH":
      return buildCaseFindingPrompt;
    case "UK":
      return buildUKCaseFindingPrompt;
    default:
      throw new HttpError(`No case-finding prompt builder configured for jurisdiction: ${jurisdiction}`, 501);
  }
}

export function getCaseReconstructionPromptBuilder(jurisdiction: Jurisdiction) {
  switch (jurisdiction) {
    case "PH":
      return buildCaseReconstructionPrompt;
    case "UK":
      return buildUKCaseReconstructionPrompt;
    default:
      throw new HttpError(`No case-reconstruction prompt builder configured for jurisdiction: ${jurisdiction}`, 501);
  }
}

export function getCaseStrategyPromptBuilder(jurisdiction: Jurisdiction) {
  switch (jurisdiction) {
    case "PH":
      return buildCaseStrategyPrompt;
    case "UK":
      return buildUKCaseStrategyPrompt;
    default:
      throw new HttpError(`No case-strategy prompt builder configured for jurisdiction: ${jurisdiction}`, 501);
  }
}

export function getSourceAnalysisPromptTemplate(jurisdiction: Jurisdiction): string {
  switch (jurisdiction) {
    case "PH":
      return PH_SOURCE_ANALYSIS_PROMPT;
    case "UK":
      return UK_SOURCE_ANALYSIS_PROMPT;
    default:
      throw new HttpError(`No source-analysis prompt configured for jurisdiction: ${jurisdiction}`, 501);
  }
}

export function getChatTitlePromptBuilder(jurisdiction: Jurisdiction) {
  switch (jurisdiction) {
    case "PH":
      return buildPHChatTitlePrompt;
    case "UK":
      return buildUKChatTitlePrompt;
    default:
      throw new HttpError(`No chat-title prompt builder configured for jurisdiction: ${jurisdiction}`, 501);
  }
}
