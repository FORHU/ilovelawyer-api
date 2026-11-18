/** Hand-authored, not Prisma-generated: Tenant.code is a plain `String @unique` column
 * (no DB-level enum), so this is the single source of truth for the closed set of valid
 * codes at the TypeScript level. Keep in sync with prisma/seeders/tenant.seeder.ts and the
 * lawyer app's lib/tenant-code/resolve-host.ts.
 * Belongs to Organization only; never to User. See prisma/schema.prisma's Organization
 * model and docs/adr/0004-collapse-jurisdiction-into-tenant.md. */
export const TENANT_CODES = ["PH", "UK", "KR"] as const;

export type TenantCode = (typeof TENANT_CODES)[number];

export function isTenantCode(code: unknown): code is TenantCode {
  return TENANT_CODES.includes(code as TenantCode);
}

/** Validates a Tenant.code value read from the DB (a plain `String` column, so TypeScript
 * can't narrow it on its own) against the known set. Throws rather than silently casting,
 * so a corrupted/misconfigured Tenant row surfaces immediately instead of masquerading as
 * a valid code downstream. */
export function asTenantCode(code: string): TenantCode {
  if (!isTenantCode(code)) {
    throw new Error(`Unknown Tenant code "${code}" — expected one of: ${TENANT_CODES.join(", ")}`);
  }
  return code;
}
