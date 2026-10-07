// Unlike the other UK prompts, this one shares the PH body (../../../constants/missing-evidence.constants):
// it asks which facts a claim rests on that no document proves, and states no rule of law, so
// there is nothing jurisdiction-specific to restate. Only the role line differs.
import { buildMissingEvidencePromptBody, MissingEvidencePromptClaim } from "../../../constants/missing-evidence.constants";
import { ukJurisdictionRoleLabel } from "./uk-jurisdiction-role-label";

export function buildUKMissingEvidencePrompt(
  docs: { id: string; name: string }[],
  claims: MissingEvidencePromptClaim[],
  ukJurisdiction?: string | null,
): string {
  return buildMissingEvidencePromptBody(docs, claims, ukJurisdictionRoleLabel(ukJurisdiction));
}
