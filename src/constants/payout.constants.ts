/**
 * The quotation payment terms every tenant starts with (PayoutSettingsSvc), edited per tenant in the
 * admin app. The platform fee is added on top of the lawyer's service fee for the client to pay; the
 * lawyer receives the service fee in full. Stripe's processing fee comes out of the platform fee.
 */
export const PAYOUT_SETTINGS_DEFAULTS = {
  currency: "GBP",
  /** 15%, in basis points. */
  platformFeeBps: 1500,
  /** £5: enough to cover Stripe's fee on a small first consultation. */
  minPlatformFeeMinor: 500,
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

/**
 * The platform fee on a service fee: `bps` of it rounded half-up, never below `minFeeMinor`. A free
 * quote (a free first consultation) has no fee: there's nothing to pay.
 */
export function platformFeeOf(serviceFeeMinor: number, bps: number, minFeeMinor: number): number {
  if (serviceFeeMinor <= 0) return 0;
  return Math.max(Math.floor((serviceFeeMinor * bps + 5000) / 10000), minFeeMinor);
}
