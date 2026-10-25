/** TenantSetting.key values. A Tenant with no row for a key gets that key's default —
 * see TenantSettingSvc. */
export const TENANT_SETTING_KEYS = {
  signupAutoApprove: "signup.autoApprove",
  // { feeType: "FIXED" | "PERCENT", feeAmount: number } — AccountTopUpPricingSvc. FIXED is dollars,
  // PERCENT is 0-100.
  accountTopUpFee: "accountTopUp.fee",
} as const;

/** AccountTopUpPricingSvc.quote's fallback when a tenant has no fee row yet — a lawyer can still
 * top up before an admin has ever opened the settings page. */
export const ACCOUNT_TOPUP_FEE_DEFAULT = { feeType: "FIXED" as const, feeAmount: 0.8 };

/** The placeholder B2B tiers every Tenant starts with (PaymentPlanSvc). The payment_plan_tiers
 * migration seeded these into the tenants that existed then; the tenant seeder adds them to any
 * tenant created later (a fresh database runs migrations before seeding). Keep the two in step. */
export const PAYMENT_PLAN_DEFAULT_TIERS = [
  { code: "standard", name: "Standard", level: 0, feeUsd: 20, includedAllowanceUsd: 10, caseLimit: 5, clientRequestLimit: 3 },
  { code: "pro", name: "Pro", level: 1, feeUsd: 50, includedAllowanceUsd: 30, caseLimit: 10, clientRequestLimit: 10 },
  { code: "max", name: "Max", level: 2, feeUsd: 100, includedAllowanceUsd: 80, caseLimit: 50, clientRequestLimit: 0 },
] as const;

export const TENANT_SETTINGS_CACHE_TTL_S = 60;

// "Approve all pending" (BulkApprovalRunner). Each approval sends one email, so keep
// concurrency within the mail provider's send-rate limit.
export const BULK_APPROVE_CONCURRENCY = 5;
// The lock's TTL is refreshed after every batch, so this only needs to outlive one batch —
// it's what frees the lock if the process dies mid-run.
export const BULK_APPROVE_LOCK_TTL_S = 15 * 60;
// How long a finished run's counts stay visible on the Settings page.
export const BULK_APPROVE_PROGRESS_TTL_S = 24 * 60 * 60;
