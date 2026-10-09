import { ConsentPurpose } from "@prisma/client";
import { TERMS_VERSION } from "./auth.constants";

/** The purposes the product acts on, in the order they are listed. ANALYTICS and MARKETING stay in
 * the database enum (removing enum values needs a migration) but nothing in the system uses them,
 * so they are not listed, cannot be set, and have no version. Add a purpose here, with a version,
 * in the same change that adds the code that needs it. */
export const ACTIVE_CONSENT_PURPOSES: readonly ConsentPurpose[] = ["TERMS_OF_SERVICE", "AI_PROCESSING"];

/** Version of the policy text behind each purpose a user can answer for. Bump one when its text
 * materially changes, so an old answer can be told apart from one given to the current text.
 * Terms of Service reads TERMS_VERSION and is answered at signup, not here. */
export const CONSENT_VERSIONS: Partial<Record<ConsentPurpose, string>> = {
  TERMS_OF_SERVICE: TERMS_VERSION,
  AI_PROCESSING: "2026-10",
};

/** What a purpose allows for someone who has never answered it. AI processing is on by default:
 * the Terms of Service say so and agreeing to them is the consent, so only an explicit withdrawal
 * blocks it. Terms of Service has no answer to withdraw here, so it is always allowed. A purpose
 * not listed here is blocked. */
export const CONSENT_WHEN_UNANSWERED: Partial<Record<ConsentPurpose, "allowed" | "blocked">> = {
  TERMS_OF_SERVICE: "allowed",
  AI_PROCESSING: "allowed",
};

/** Purposes a user may grant or withdraw through the consent endpoint. Terms of Service is
 * excluded: withdrawing it means closing the account, which has its own flow. */
export const SELF_SERVICE_CONSENT_PURPOSES: readonly ConsentPurpose[] = ["AI_PROCESSING"];

/** Where an answer was given, stored with it. */
export const CONSENT_SOURCES = ["settings", "first_login"] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];
