-- See docs/adr/0004-collapse-jurisdiction-into-tenant.md.
--
-- Tenant.createdAt/updatedAt are declared in schema.prisma but were never added by any
-- migration file in this repo — only by a migration that was applied directly to a live DB
-- and later lost (see the drift this whole migration exists to recover from). Add them here
-- so the table actually matches the schema before this migration inserts rows into it.
ALTER TABLE "Tenant" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Tenant" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Defensively ensures the two known Tenant rows exist before backfilling from them, rather
-- than assuming prisma/seeders/tenant.seeder.ts has already run in whatever environment this
-- migration lands in (migrate deploy does not auto-seed, unlike migrate dev/reset). Fixed,
-- well-known ids — these are stable reference rows, not user data.
INSERT INTO "Tenant" ("id", "code", "name", "createdAt", "updatedAt")
VALUES
  ('00000000-0000-0000-0000-000000000001', 'PH', 'Philippines', now(), now()),
  ('00000000-0000-0000-0000-000000000002', 'UK', 'United Kingdom', now(), now())
ON CONFLICT ("code") DO NOTHING;

-- Backfill Organization.tenantId for any row that doesn't already have one, from the
-- jurisdiction column this migration is about to drop.
UPDATE "Organization" o
SET "tenantId" = t."id"
FROM "Tenant" t
WHERE o."tenantId" IS NULL AND t."code" = o."jurisdiction"::text;

-- Organization.tenantId is now always populated — make it required, and tighten its FK from
-- SET NULL to RESTRICT (a required column can't accept SET NULL on delete).
ALTER TABLE "Organization" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Organization" DROP CONSTRAINT "Organization_tenantId_fkey";
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Organization" DROP COLUMN "jurisdiction";

-- LegalSourceAnalysisCache: replace the jurisdiction-keyed cache constraint with a real
-- tenantId FK (see ADR 0004 for why).
ALTER TABLE "LegalSourceAnalysisCache" ADD COLUMN "tenantId" TEXT;

UPDATE "LegalSourceAnalysisCache" c
SET "tenantId" = t."id"
FROM "Tenant" t
WHERE t."code" = c."jurisdiction"::text;

DROP INDEX "LegalSourceAnalysisCache_normalizedKeyword_jurisdiction_key";
ALTER TABLE "LegalSourceAnalysisCache" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "LegalSourceAnalysisCache" DROP COLUMN "jurisdiction";
ALTER TABLE "LegalSourceAnalysisCache" ADD CONSTRAINT "LegalSourceAnalysisCache_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "LegalSourceAnalysisCache_normalizedKeyword_tenantId_key" ON "LegalSourceAnalysisCache"("normalizedKeyword", "tenantId");

-- Jurisdiction enum is no longer referenced by any column — safe to drop.
DROP TYPE "Jurisdiction";
