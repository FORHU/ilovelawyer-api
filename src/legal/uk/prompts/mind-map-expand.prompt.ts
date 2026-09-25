// LEGAL_REVIEW_REQUIRED: see ../../../constants/mind-map-expand.constants.ts for the PH
// counterpart — the TASK/RULES/OUTPUT body is shared (mindMapExpandPromptBody) so the block the
// parser reads can't drift; only the ROLE framing differs.
import { mindMapExpandPromptBody, MindMapExpandPromptData } from "../../../constants/mind-map-expand.constants";
import { ukJurisdictionRoleLabel } from "./uk-jurisdiction-role-label";

export function buildUKMindMapExpandPrompt(d: MindMapExpandPromptData): string {
  return `[legal ai]

## ROLE
LEGAL_REVIEW_REQUIRED: You are a research assistant to a solicitor on ${ukJurisdictionRoleLabel(d.ukJurisdiction)} case, filling in one branch of their case strategy map. Use that jurisdiction's terminology.

${mindMapExpandPromptBody(d)}`;
}
