import { TenantCode } from "../types/tenant-code";
import HttpError from "../utils/http-error";
import {
  buildRedTeamPrompt,
  buildWitnessScoringPrompt,
  buildWitnessExtractPrompt,
  buildCaseFindingPrompt,
  buildCaseOutlookPrompt,
  buildCaseReconstructionPrompt,
  buildCaseStrategyPrompt,
  PH_SOURCE_ANALYSIS_PROMPT,
  buildPHChatTitlePrompt,
  buildMindMapExpandPrompt,
  buildMindMapDocumentsPrompt,
} from "./ph/prompts";
import {
  buildUKRedTeamPrompt,
  buildUKWitnessScoringPrompt,
  buildUKWitnessExtractPrompt,
  buildUKCaseFindingPrompt,
  buildUKCaseOutlookPrompt,
  buildUKCaseReconstructionPrompt,
  buildUKCaseStrategyPrompt,
  UK_SOURCE_ANALYSIS_PROMPT,
  buildUKChatTitlePrompt,
  buildUKMindMapExpandPrompt,
  buildUKMindMapDocumentsPrompt,
} from "./uk/prompts";

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

export function getWitnessScoringPromptBuilder(tenantCode: TenantCode) {
  switch (tenantCode) {
    case "PH":
      return buildWitnessScoringPrompt;
    case "UK":
      return buildUKWitnessScoringPrompt;
    default:
      throw new HttpError(`No witness-scoring prompt builder configured for tenantCode: ${tenantCode}`, 501);
  }
}

export function getWitnessExtractPromptBuilder(tenantCode: TenantCode) {
  switch (tenantCode) {
    case "PH":
      return buildWitnessExtractPrompt;
    case "UK":
      return buildUKWitnessExtractPrompt;
    default:
      throw new HttpError(`No witness-extract prompt builder configured for tenantCode: ${tenantCode}`, 501);
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

export function getCaseOutlookPromptBuilder(tenantCode: TenantCode) {
  switch (tenantCode) {
    case "PH":
      return buildCaseOutlookPrompt;
    case "UK":
      return buildUKCaseOutlookPrompt;
    default:
      throw new HttpError(`No case-outlook prompt builder configured for tenantCode: ${tenantCode}`, 501);
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

export function getMindMapExpandPromptBuilder(tenantCode: TenantCode) {
  switch (tenantCode) {
    case "PH":
      return buildMindMapExpandPrompt;
    case "UK":
      return buildUKMindMapExpandPrompt;
    default:
      throw new HttpError(`No mind-map-expand prompt builder configured for tenantCode: ${tenantCode}`, 501);
  }
}

export function getMindMapDocumentsPromptBuilder(tenantCode: TenantCode) {
  switch (tenantCode) {
    case "PH":
      return buildMindMapDocumentsPrompt;
    case "UK":
      return buildUKMindMapDocumentsPrompt;
    default:
      throw new HttpError(`No mind-map-documents prompt builder configured for tenantCode: ${tenantCode}`, 501);
  }
}
