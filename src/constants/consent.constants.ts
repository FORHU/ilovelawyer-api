import { ConsentPurpose } from "@prisma/client";
import { TERMS_VERSION } from "./auth.constants";

/** Version of the policy text behind each purpose a user can answer for. Bump one when its text
 * materially changes, so an old answer can be told apart from one given to the current text.
 * Terms of Service reads TERMS_VERSION and is answered at signup, not here. */
export const CONSENT_VERSIONS: Record<ConsentPurpose, string> = {
  TERMS_OF_SERVICE: TERMS_VERSION,
  AI_PROCESSING: "2026-10",
  ANALYTICS: "2026-10",
  MARKETING: "2026-10",
};

/** Purposes a user may grant or withdraw through the consent endpoint. Terms of Service is
 * excluded: withdrawing it means closing the account, which has its own flow. */
export const SELF_SERVICE_CONSENT_PURPOSES: readonly ConsentPurpose[] = ["AI_PROCESSING", "ANALYTICS", "MARKETING"];
