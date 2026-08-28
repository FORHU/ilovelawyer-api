import { TenantCode } from "../types/tenant-code";
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

/** Every getter below selects strictly by tenantCode — never by client input — and throws
 * rather than falling back to another tenantCode's prompt when unmapped. */

export function getRedTeamPromptBuilder(tenantCode: TenantCode) {
  switch (tenantCode) {
    case "PH":
      return buildRedTeamPrompt;
    case "UK":
      return buildUKRedTeamPrompt;
    default:
      throw new HttpError(`No red-team prompt builder configured for tenantCode: ${tenantCode}`, 501);
  }
}

export function getCaseFindingPromptBuilder(tenantCode: TenantCode) {
  switch (tenantCode) {
    case "PH":
      return buildCaseFindingPrompt;
    case "UK":
      return buildUKCaseFindingPrompt;
    default:
      throw new HttpError(`No case-finding prompt builder configured for tenantCode: ${tenantCode}`, 501);
  }
}

export function getCaseReconstructionPromptBuilder(tenantCode: TenantCode) {
  switch (tenantCode) {
    case "PH":
      return buildCaseReconstructionPrompt;
    case "UK":
      return buildUKCaseReconstructionPrompt;
    default:
      throw new HttpError(`No case-reconstruction prompt builder configured for tenantCode: ${tenantCode}`, 501);
  }
}

export function getCaseStrategyPromptBuilder(tenantCode: TenantCode) {
  switch (tenantCode) {
    case "PH":
      return buildCaseStrategyPrompt;
    case "UK":
      return buildUKCaseStrategyPrompt;
    default:
      throw new HttpError(`No case-strategy prompt builder configured for tenantCode: ${tenantCode}`, 501);
  }
}

export function getSourceAnalysisPromptTemplate(tenantCode: TenantCode): string {
  switch (tenantCode) {
    case "PH":
      return PH_SOURCE_ANALYSIS_PROMPT;
    case "UK":
      return UK_SOURCE_ANALYSIS_PROMPT;
    default:
      throw new HttpError(`No source-analysis prompt configured for tenantCode: ${tenantCode}`, 501);
  }
}

export function getChatTitlePromptBuilder(tenantCode: TenantCode) {
  switch (tenantCode) {
    case "PH":
      return buildPHChatTitlePrompt;
    case "UK":
      return buildUKChatTitlePrompt;
    default:
      throw new HttpError(`No chat-title prompt builder configured for tenantCode: ${tenantCode}`, 501);
  }
}
