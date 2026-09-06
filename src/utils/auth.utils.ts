import crypto from "crypto";
import type { TenantCode } from "../types/tenant-code";
import { EMAIL_VERIFICATION_CODE_LENGTH } from "../constants";

export function generateOtpCode(): string {
  return crypto
    .randomInt(0, 10 ** EMAIL_VERIFICATION_CODE_LENGTH)
    .toString()
    .padStart(EMAIL_VERIFICATION_CODE_LENGTH, "0");
}

/** Names the Tenant a duplicate-email signup attempt actually belongs to, so the user knows
 * to sign in from that Tenant's site instead of retrying signup here — rather than a bare
 * "already in use" that gives no hint why. Suppressed when the existing account's Tenant is
 * the same one this request is already on (nothing to redirect them to); still shown when
 * this request's Tenant is unresolved (local dev, direct API calls) — unknown is treated as
 * "could be different," not as "same," since a bare message would give no lead there either.
 * Always falls back to the generic message for an existing user with no Tenant link at all
 * (e.g. one created before Tenant assignment existed). */
export function duplicateEmailMessage(
  existingUser: { tenant: { code: string; name: string } | null },
  base: string,
  requestTenantCode: TenantCode | null,
): string {
  if (!existingUser.tenant) return base;
  if (existingUser.tenant.code === requestTenantCode) return base;
  return `${base} — this email is registered under our ${existingUser.tenant.name} site. Please sign in there instead.`;
}
