import crypto from "crypto";
import { Prisma } from "@prisma/client";
import type { TenantCode } from "../types/tenant-code";
import { EMAIL_VERIFICATION_CODE_LENGTH } from "../constants";

export function generateOtpCode(): string {
  return crypto
    .randomInt(0, 10 ** EMAIL_VERIFICATION_CODE_LENGTH)
    .toString()
    .padStart(EMAIL_VERIFICATION_CODE_LENGTH, "0");
}

/** The one canonical form every User.email is stored and looked up in — trimmed and
 * lowercased, so "John@Firm.com " typed at signup and "john@firm.com" from Google resolve to
 * the same account instead of two. Deliberately does nothing provider-specific (no Gmail dot
 * or +tag stripping): outside gmail.com those are genuinely different mailboxes. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** True when `err` is Prisma's unique-constraint violation (P2002) on `field`. Prisma 5 on
 * Postgres reports `meta.target` as an array of column names, but some drivers/versions give
 * the constraint name as a string (e.g. "User_email_key") — both are matched. */
export function isUniqueViolation(err: unknown, field: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") return false;
  const target = err.meta?.target;
  if (Array.isArray(target)) return target.includes(field);
  return typeof target === "string" && target.includes(field);
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
