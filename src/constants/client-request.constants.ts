/**
 * What a client agrees to when asking for a lawyer (POST /api/client/lawyer-requests). DRAFT
 * wording, pending a UK solicitor's review (FORHU/ilovelawyer-app#846). It already says what the
 * #845 decisions require: names reach only the claiming lawyer, and only for the conflict check;
 * either side can end the engagement; the lawyer may keep a copy of the case. Bump the version
 * whenever the text changes: a client who agreed to an older version is asked again
 * (CONSENT_VERSION_STALE).
 */
export const CLIENT_REQUEST_CONSENT_VERSION = "2026-10-21-draft";

export const CLIENT_REQUEST_CONSENT_TEXT = [
  "We'll share an anonymised summary of your case with verified UK lawyers who may take it on. It leaves out names and documents.",
  "The first lawyer to accept will also see the names of the people and organisations in your case, only to check they have no conflict of interest.",
  "If you confirm that lawyer, they can read your case, its documents and your chat with the AI. Either of you can end this at any time.",
  "The lawyer may keep a copy of your case afterwards, as solicitors are required to keep their files.",
].join("\n\n");

/** The SRA requires telling the client the lawyer pays us for the introduction. */
export const CLIENT_REQUEST_REFERRAL_DISCLOSURE =
  "ilovelawyer is paid a fixed fee by the lawyer for introducing you. You don't pay us anything for this, and it doesn't change what the lawyer charges you.";

export const CLIENT_REQUEST_NOTE_MAX_LENGTH = 1000;

/** A lawyer's quote (#512): the message to the client, and the most it can ask (£100,000, in pence). */
export const CLIENT_REQUEST_QUOTE_MESSAGE_MAX_LENGTH = 2000;
export const CLIENT_REQUEST_QUOTE_MAX_MINOR = 10_000_000;
/** A lawyer's note when releasing a request (#512). Kept on the claim only. */
export const CLIENT_REQUEST_RELEASE_NOTE_MAX_LENGTH = 500;

/** What confirming a lawyer charges their organization (#513), in pence: the introduction fee. A
 * PLACEHOLDER until the price is signed off (FORHU/ilovelawyer-app#846). */
export const CLIENT_REQUEST_PER_CASE_FEE_MINOR = 5000;

/** The AI top-up packs an engaged lawyer can buy (#516), in pence: what the card is charged, and the
 * AI credit it adds to the engagement's budget. PLACEHOLDERS until the prices are signed off
 * (FORHU/ilovelawyer-app#846: 50 USD for 30 USD of credit, here in GBP at the budget's placeholder
 * rate). */
export const ENGAGEMENT_AI_TOP_UP_PACKS = [{ id: "standard", priceMinor: 4000, creditMinor: 2400, currency: "GBP" }] as const;
