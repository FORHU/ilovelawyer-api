/** TenantSetting.key values. A Tenant with no row for a key gets that key's default —
 * see TenantSettingSvc. */
export const TENANT_SETTING_KEYS = {
  signupAutoApprove: "signup.autoApprove",
} as const;

export const TENANT_SETTINGS_CACHE_TTL_S = 60;

// "Approve all pending" (BulkApprovalRunner). Each approval sends one email, so keep
// concurrency within the mail provider's send-rate limit.
export const BULK_APPROVE_CONCURRENCY = 5;
// The lock's TTL is refreshed after every batch, so this only needs to outlive one batch —
// it's what frees the lock if the process dies mid-run.
export const BULK_APPROVE_LOCK_TTL_S = 15 * 60;
// How long a finished run's counts stay visible on the Settings page.
export const BULK_APPROVE_PROGRESS_TTL_S = 24 * 60 * 60;
