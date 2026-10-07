import { buildMissingEvidencePromptBody, MissingEvidencePromptClaim } from "../../../constants/missing-evidence.constants";

/** Same signature as the UK builder so prompt-registry's result is callable either way; PH takes
 * no jurisdiction argument of its own. */
export function buildMissingEvidencePrompt(
  docs: { id: string; name: string }[],
  claims: MissingEvidencePromptClaim[],
  _ukJurisdiction?: string | null,
): string {
  return buildMissingEvidencePromptBody(docs, claims, "this");
}
