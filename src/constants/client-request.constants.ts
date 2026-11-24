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

export const CLIENT_REQUEST_CONSENT_VERSION = "2026-11-10-draft";

// What hiring a lawyer hands over, in the consent text and again on the quote and payment screens
// (CLIENT_REQUEST_SHARING_NOTICE, #922), so the two can't drift apart.
export const WHAT_HIRING_SHARES = "Once paid, they can read your case, its documents and your chat with the AI. Either of you can end this at any time.";
export const LAWYER_KEEPS_COPY = "The lawyer may keep a copy of your case afterwards, as solicitors are required to keep their files.";

/** Shown with every quote and on the payment screen, where the lawyer is actually given the case. */
export const CLIENT_REQUEST_SHARING_NOTICE = `${WHAT_HIRING_SHARES} ${LAWYER_KEEPS_COPY}`;

export const CLIENT_REQUEST_CONSENT_TEXT = [
  "We'll share an anonymised summary of your case with verified UK lawyers who may take it on. It leaves out names and documents.",
  `Up to ${CLIENT_REQUEST_MAX_LAWYERS} lawyers can take up your request. Each will also see the names of the people and organisations in your case, only to check they have no conflict of interest, and can send you a quote.`,
  `If you hire one of them, you pay their quote and ilovelawyer's platform fee through ilovelawyer. ${WHAT_HIRING_SHARES}`,
  LAWYER_KEEPS_COPY,
].join("\n\n");

/** A request to one lawyer by name (the marketplace's Request): how long only they are offered it
 * before it goes to every matching lawyer. */
export const CLIENT_REQUEST_DIRECT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** What a client agrees to when asking one lawyer by name. Same DRAFT status and review as the text
 * above, which it follows, and which applies if the request goes wider. Its own version: bump it
 * whenever this text changes. */
export const CLIENT_REQUEST_DIRECT_CONSENT_VERSION = "2026-11-04-direct-draft-3";

// Laid out like CLIENT_REQUEST_CONSENT_TEXT, paragraph for paragraph and about as long, so the two
// forms look the same and fit the same screen.
export const CLIENT_REQUEST_DIRECT_CONSENT_TEXT = [
  "We'll share an anonymised summary of your case with the lawyer you chose, and only them at first. It leaves out names and documents.",
  `If they take it up, they'll also see the names of the people and organisations in your case, only to check for conflicts, and can send you a quote. If not within 24 hours, up to ${CLIENT_REQUEST_MAX_LAWYERS} other matching lawyers can.`,
  `If you hire a lawyer, you pay their quote and ilovelawyer's platform fee through ilovelawyer. ${WHAT_HIRING_SHARES}`,
  LAWYER_KEEPS_COPY,
].join("\n\n");

/** How the platform is paid, shown on every quote and acknowledged to accept one. DRAFT wording,
 * pending the same review as the consent text (#846): the client pays the lawyer's quote through
 * ilovelawyer, nothing more; ilovelawyer's fee is deducted from what the lawyer receives. */
export const CLIENT_REQUEST_REFERRAL_DISCLOSURE =
  "You pay the lawyer's quoted fee, nothing more, through ilovelawyer. ilovelawyer's platform fee comes out of what the lawyer receives, so it adds nothing to what you pay.";

/**
 * The KR site's wording: what a KR client agrees to and is shown, in Korean, for KR lawyers. Its own
 * versions (a KR client records one of these, never a UK one), bumped whenever the Korean changes.
 * DRAFT pending review by Korean counsel, together with the referral model itself (변호사법 제34조).
 */
export const KR_WHAT_HIRING_SHARES = "선임된 변호사는 사건, 서류, AI와의 채팅 내용을 볼 수 있습니다. 양측 모두 언제든지 의뢰를 종료할 수 있습니다.";
export const KR_LAWYER_KEEPS_COPY = "변호사는 관련 법령에 따라 의뢰가 끝난 후에도 사건 기록의 사본을 보관할 수 있습니다.";
export const KR_CLIENT_REQUEST_SHARING_NOTICE = `${KR_WHAT_HIRING_SHARES} ${KR_LAWYER_KEEPS_COPY}`;

export const KR_CLIENT_REQUEST_CONSENT_VERSION = "kr-2026-11-24-direct-pay-draft";
export const KR_CLIENT_REQUEST_CONSENT_TEXT = [
  "사건을 맡을 수 있는 검증된 한국 변호사에게 익명 처리된 사건 요약을 공유합니다. 이름과 서류는 포함되지 않습니다.",
  `최대 ${CLIENT_REQUEST_MAX_LAWYERS}명의 변호사가 요청을 수락할 수 있습니다. 각 변호사는 이해충돌이 없는지 확인하기 위해서만 사건 관련 인물과 단체의 이름을 볼 수 있으며, 견적을 보낼 수 있습니다.`,
  `그중 한 명을 선임하면 변호사 보수는 변호사와 직접 협의해 지급합니다. ilovelawyer는 보수를 대신 받지 않으며 수수료도 받지 않습니다. ${KR_WHAT_HIRING_SHARES}`,
  KR_LAWYER_KEEPS_COPY,
].join("\n\n");

export const KR_CLIENT_REQUEST_DIRECT_CONSENT_VERSION = "kr-2026-11-24-direct-pay-direct-draft";
export const KR_CLIENT_REQUEST_DIRECT_CONSENT_TEXT = [
  "선택한 변호사에게만 먼저 익명 처리된 사건 요약을 공유합니다. 이름과 서류는 포함되지 않습니다.",
  `변호사가 수락하면 이해충돌 확인을 위해서만 사건 관련 인물과 단체의 이름을 볼 수 있으며, 견적을 보낼 수 있습니다. 24시간 이내에 수락하지 않으면 조건에 맞는 다른 변호사 최대 ${CLIENT_REQUEST_MAX_LAWYERS}명이 수락할 수 있습니다.`,
  `변호사를 선임하면 변호사 보수는 변호사와 직접 협의해 지급합니다. ilovelawyer는 보수를 대신 받지 않으며 수수료도 받지 않습니다. ${KR_WHAT_HIRING_SHARES}`,
  KR_LAWYER_KEEPS_COPY,
].join("\n\n");

// KR clients pay the lawyer directly (paysLawyerDirectly): nothing is paid through ilovelawyer.
export const KR_CLIENT_REQUEST_REFERRAL_DISCLOSURE =
  "변호사 보수는 변호사와 직접 협의해 지급합니다. ilovelawyer는 보수를 대신 받지 않으며 수수료도 받지 않습니다.";

/** Sites where the client pays the hired lawyer directly (FORHU/ilovelawyer-api#695): accepting a
 * quote engages the lawyer at once, nothing is paid through ilovelawyer, and no fee is taken. */
const PAYS_LAWYER_DIRECTLY_SITES: ReadonlySet<string> = new Set(["KR"]);

export function paysLawyerDirectly(site: string | null | undefined): boolean {
  return !!site && PAYS_LAWYER_DIRECTLY_SITES.has(site);
}

/** What a client on `site` agrees to and is shown about asking for a lawyer: the KR site's Korean, or
 * the UK's. */
export function requestWordingFor(site: string) {
  return site === "KR"
    ? {
        consent: { version: KR_CLIENT_REQUEST_CONSENT_VERSION, consentText: KR_CLIENT_REQUEST_CONSENT_TEXT },
        directConsent: { version: KR_CLIENT_REQUEST_DIRECT_CONSENT_VERSION, consentText: KR_CLIENT_REQUEST_DIRECT_CONSENT_TEXT },
        referralDisclosure: KR_CLIENT_REQUEST_REFERRAL_DISCLOSURE,
        sharingNotice: KR_CLIENT_REQUEST_SHARING_NOTICE,
      }
    : {
        consent: { version: CLIENT_REQUEST_CONSENT_VERSION, consentText: CLIENT_REQUEST_CONSENT_TEXT },
        directConsent: { version: CLIENT_REQUEST_DIRECT_CONSENT_VERSION, consentText: CLIENT_REQUEST_DIRECT_CONSENT_TEXT },
        referralDisclosure: CLIENT_REQUEST_REFERRAL_DISCLOSURE,
        sharingNotice: CLIENT_REQUEST_SHARING_NOTICE,
      };
}

export const CLIENT_REQUEST_NOTE_MAX_LENGTH = 1000;

/** A lawyer's quote (#512): the message to the client, and the most it can ask (£100,000, in pence). */
export const CLIENT_REQUEST_QUOTE_MESSAGE_MAX_LENGTH = 2000;
export const CLIENT_REQUEST_QUOTE_MAX_MINOR = 10_000_000;

/** The largest quote per currency, to catch a typo like an extra zero: £100,000 on UK, and about the
 * same in won on KR (₩200,000,000; won has no minor unit). Validation lets the largest through and
 * the service checks the quote's own currency (quoteMaxMinorOf). */
const QUOTE_MAX_MINOR_BY_CURRENCY: Record<string, number> = { GBP: CLIENT_REQUEST_QUOTE_MAX_MINOR, KRW: 200_000_000 };
export const CLIENT_REQUEST_QUOTE_MAX_MINOR_ANY = Math.max(...Object.values(QUOTE_MAX_MINOR_BY_CURRENCY));

export function quoteMaxMinorOf(currency: string): number {
  return QUOTE_MAX_MINOR_BY_CURRENCY[currency] ?? CLIENT_REQUEST_QUOTE_MAX_MINOR;
}

/** The currencies a client request is quoted and paid in, one per site that has requests. */
export const CLIENT_REQUEST_CURRENCIES = ["GBP", "KRW"] as const;
/** A lawyer's note when releasing a request (#512). Kept on the claim only. */
export const CLIENT_REQUEST_RELEASE_NOTE_MAX_LENGTH = 500;
/** A lawyer's note when passing on a request. Read by ilovelawyer staff only. */
export const CLIENT_REQUEST_PASS_NOTE_MAX_LENGTH = 500;

/** How long a confirmed client waits on a lawyer's failing introduction fee before the request goes
 * back to other lawyers (#933, ClientRequestSweepQueue): from when the client confirmed. */
export const CLIENT_REQUEST_UNPAID_FEE_HOURS = 48;

/** How long the client has to answer the lawyer's "the work is finished" before the engagement closes
 * by itself (EngagementCompletionSvc, ClientRequestSweepQueue): from when the lawyer asked. */
export const ENGAGEMENT_COMPLETION_CONFIRM_DAYS = 7;
/** The client's reason when they say the work isn't finished, shown to the lawyer. */
export const ENGAGEMENT_COMPLETION_DECLINE_MAX_LENGTH = 1000;

/** A client who has a request in one of these can't delete their account (UsersSvc.requestDeletion,
 * 409 OPEN_LAWYER_REQUESTS): a lawyer is still working on it, may hold the client's case, or the
 * client is part-way to hiring one. CLOSED, EXPIRED and WITHDRAWN don't block. */
export const DELETION_BLOCKING_REQUEST_STATUSES = ["REQUESTED", "ROUTED", "CLAIMED", "QUOTED", "CONFIRMED", "ENGAGED"] as const;
