/**
 * What a client agrees to when asking for a lawyer (POST /api/client/lawyer-requests). DRAFT
 * wording, pending a UK solicitor's review (FORHU/ilovelawyer-app#846). It already says what the
 * #845 decisions require, as changed for several lawyers on one request (phase 5): names reach only
 * the lawyers who join it, at most CLIENT_REQUEST_MAX_LAWYERS, and only for the conflict check;
 * either side can end the engagement; the lawyer may keep a copy of the case. Bump the version
 * whenever the text changes: a client who agreed to an older version is asked again
 * (CONSENT_VERSION_STALE).
 */
/** Several lawyers on one request: how many can join it at once (ClientRequestClaimRepo.claim). */
export const CLIENT_REQUEST_MAX_LAWYERS = 3;

/** How long the client has to pick a quote, from the first quote, before the request expires. */
export const CLIENT_REQUEST_PICK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const CLIENT_REQUEST_CONSENT_VERSION = "2026-10-29-draft";

export const CLIENT_REQUEST_CONSENT_TEXT = [
  "We'll share an anonymised summary of your case with verified UK lawyers who may take it on. It leaves out names and documents.",
  `Up to ${CLIENT_REQUEST_MAX_LAWYERS} lawyers can take up your request. Each will also see the names of the people and organisations in your case, only to check they have no conflict of interest, and can send you a quote.`,
  "If you hire one of them, they can read your case, its documents and your chat with the AI. Either of you can end this at any time.",
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

/** How long a confirmed client waits on a lawyer's failing introduction fee before the request goes
 * back to other lawyers (#933, ClientRequestSweepQueue): from when the client confirmed. */
export const CLIENT_REQUEST_UNPAID_FEE_HOURS = 48;
