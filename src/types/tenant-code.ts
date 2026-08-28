/** Hand-authored, not Prisma-generated: Tenant.code is a plain `String @unique` column
 * (no DB-level enum), so this is the single source of truth for the closed set of valid
 * codes at the TypeScript level. Keep in sync with prisma/seeders/tenant.seeder.ts.
 * Belongs to Organization only; never to User. See prisma/schema.prisma's Organization
 * model and docs/adr/0004-collapse-jurisdiction-into-tenant.md. */
export type TenantCode = "PH" | "UK";

const VALID_CODES: readonly TenantCode[] = ["PH", "UK"];

/** Validates a Tenant.code value read from the DB (a plain `String` column, so TypeScript
 * can't narrow it on its own) against the known set. Throws rather than silently casting,
 * so a corrupted/misconfigured Tenant row surfaces immediately instead of masquerading as
 * a valid code downstream. */
export function asTenantCode(code: string): TenantCode {
  if (!VALID_CODES.includes(code as TenantCode)) {
    throw new Error(`Unknown Tenant code "${code}" — expected one of: ${VALID_CODES.join(", ")}`);
  }
  return code as TenantCode;
}
