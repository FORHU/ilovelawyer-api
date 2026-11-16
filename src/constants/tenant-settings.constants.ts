/** TenantSetting.key values. A Tenant with no row for a key gets that key's default —
 * see TenantSettingSvc. */
export const TENANT_SETTING_KEYS = {
  signupAutoApprove: "signup.autoApprove",
  // { feeType: "FIXED" | "PERCENT", feeAmount: number } — AccountTopUpPricingSvc. FIXED is an amount
  // in the site's lawyer currency (dollars; won on KR), PERCENT is 0-100.
  accountTopUpFee: "accountTopUp.fee",
  // { perUsd: number } — how much of the site's currency buys $1 of AI usage on an account top-up,
  // for a site that doesn't charge in US dollars (won on KR). AccountTopUpPricingSvc.
  accountTopUpRate: "accountTopUp.rate",
} as const;

/** AccountTopUpPricingSvc.quote's fallback for a US-dollar site with no fee row yet — a lawyer can
 * still top up before an admin has ever opened the settings page. Other currencies' defaults are in
 * ACCOUNT_TOPUP_TERMS. */
export const ACCOUNT_TOPUP_FEE_DEFAULT = { feeType: "FIXED" as const, feeAmount: 0.8 };

export const TENANT_SETTINGS_CACHE_TTL_S = 60;

// "Approve all pending" (BulkApprovalRunner). Each approval sends one email, so keep
// concurrency within the mail provider's send-rate limit.
export const BULK_APPROVE_CONCURRENCY = 5;
// The lock's TTL is refreshed after every batch, so this only needs to outlive one batch —
// it's what frees the lock if the process dies mid-run.
export const BULK_APPROVE_LOCK_TTL_S = 15 * 60;
// How long a finished run's counts stay visible on the Settings page.
export const BULK_APPROVE_PROGRESS_TTL_S = 24 * 60 * 60;
