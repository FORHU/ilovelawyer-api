/**
 * The quotation payment terms every tenant starts with (PayoutSettingsSvc), edited per tenant in the
 * admin app. The client pays the lawyer's quoted amount, nothing more; the platform fee is deducted
 * from it, and the lawyer receives the rest. Stripe's processing fee comes out of the platform fee.
 */
export const PAYOUT_SETTINGS_DEFAULTS = {
  currency: "GBP",
  /** 15%, in basis points. */
  platformFeeBps: 1500,
  /** £5: enough to cover Stripe's fee on a small first consultation. */
  minPlatformFeeMinor: 500,
  /** How long an earning waits after the engagement closes before it can be withdrawn. */
  earningsHoldDays: 7,
  /** £10. */
  minWithdrawalMinor: 1000,
} as const;

/** What an admin may set, to catch a typo. */
export const PAYOUT_LIMITS = {
  platformFeeBps: { min: 0, max: 5000 },
  minPlatformFeeMinor: { min: 0, max: 100_000 },
  earningsHoldDays: { min: 0, max: 60 },
  minWithdrawalMinor: { min: 100, max: 1_000_000 },
} as const;

export const payoutSettingsCacheKey = (tenantId: string) => `payout-settings:v1:${tenantId}`;
/** How long an admin's edit can take to reach the next quote or withdrawal. */
export const PAYOUT_SETTINGS_CACHE_TTL_S = 60;

/** The longest a lawyer can give a client to accept and pay a quote. */
export const QUOTATION_MAX_VALIDITY_DAYS = 90;
/** A quote's expiry when the lawyer's app doesn't send one (older apps, POST /client-requests/:id/quote).
 * The same default the lawyer app's form starts at. */
export const QUOTATION_DEFAULT_VALIDITY_DAYS = 7;

/**
 * The platform fee deducted from a quoted amount: `bps` of it rounded half-up, never below
 * `minFeeMinor`, and never more than the amount itself (the lawyer can't be left owing). A free quote
 * (a free first consultation) has no fee: there's nothing to deduct it from.
 */
export function platformFeeOf(quotedMinor: number, bps: number, minFeeMinor: number): number {
  if (quotedMinor <= 0) return 0;
  return Math.min(Math.max(Math.floor((quotedMinor * bps + 5000) / 10000), minFeeMinor), quotedMinor);
}
