// LEGAL_REVIEW_REQUIRED: see ../../../constants/mind-map-documents.constants.ts for the PH
// counterpart — the TASK/SHAPE/OUTPUT body is shared (mindMapDocumentsPromptBody) so the tree the
// parser and the fixed branch ids depend on can't drift; only the ROLE framing differs.
import { mindMapDocumentsPromptBody, MindMapDocumentsPromptData } from "../../../constants/mind-map-documents.constants";
import { ukJurisdictionRoleLabel } from "./uk-jurisdiction-role-label";

export function buildUKMindMapDocumentsPrompt(d: MindMapDocumentsPromptData): string {
  return `[legal ai]

## ROLE
LEGAL_REVIEW_REQUIRED: You are a research assistant to a solicitor on ${ukJurisdictionRoleLabel(d.ukJurisdiction)} case, building the case strategy map from the attached case documents. Use that jurisdiction's terminology.

${mindMapDocumentsPromptBody(d)}`;
}
