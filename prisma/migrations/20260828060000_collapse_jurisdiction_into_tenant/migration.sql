-- See docs/adr/0004-collapse-jurisdiction-into-tenant.md.
--
-- This migration recovers a database whose schema drifted from the migration history, so
-- every statement is written to be safe to (re-)run against a DB in ANY partial state —
-- some of these columns/rows/constraints may already exist from an out-of-band hotfix.
-- If a prior run of this migration failed partway (Prisma marks it "failed" and blocks all
-- further migrations), recover with:
--   npx prisma migrate resolve --rolled-back "20260828060000_collapse_jurisdiction_into_tenant"
-- then re-run `prisma migrate deploy` — this idempotent version will finish the job.

-- ── Tenant: timestamps + reference rows ──────────────────────────────────────
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Fixed, well-known ids — stable reference rows, not user data. migrate deploy does not
-- auto-seed, so ensure they exist before backfilling from them.
INSERT INTO "Tenant" ("id", "code", "name", "createdAt", "updatedAt")
VALUES
  ('00000000-0000-0000-0000-000000000001', 'PH', 'Philippines', now(), now()),
  ('00000000-0000-0000-0000-000000000002', 'UK', 'United Kingdom', now(), now())
ON CONFLICT ("code") DO NOTHING;

-- ── Organization.jurisdiction -> Organization.tenantId ───────────────────────
-- Backfill from the legacy jurisdiction column while it still exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Organization' AND column_name = 'jurisdiction'
  ) THEN
    UPDATE "Organization" o
    SET "tenantId" = t."id"
    FROM "Tenant" t
    WHERE o."tenantId" IS NULL AND t."code" = o."jurisdiction"::text;
  END IF;
END $$;

-- Anything still unresolved (jurisdiction already dropped, or an unrecognised value)
-- falls back to PH so the NOT NULL below can't fail.
UPDATE "Organization"
SET "tenantId" = '00000000-0000-0000-0000-000000000001'
WHERE "tenantId" IS NULL;

-- Required column + FK tightened from SET NULL to RESTRICT. (SET NOT NULL is a no-op if
-- already set; the FK is dropped-if-exists before being recreated.)
ALTER TABLE "Organization" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Organization" DROP CONSTRAINT IF EXISTS "Organization_tenantId_fkey";
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Organization" DROP COLUMN IF EXISTS "jurisdiction";

-- ── LegalSourceAnalysisCache.jurisdiction -> .tenantId ───────────────────────
ALTER TABLE "LegalSourceAnalysisCache" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'LegalSourceAnalysisCache' AND column_name = 'jurisdiction'
  ) THEN
    UPDATE "LegalSourceAnalysisCache" c
    SET "tenantId" = t."id"
    FROM "Tenant" t
    WHERE c."tenantId" IS NULL AND t."code" = c."jurisdiction"::text;
  END IF;
END $$;

UPDATE "LegalSourceAnalysisCache"
SET "tenantId" = '00000000-0000-0000-0000-000000000001'
WHERE "tenantId" IS NULL;

DROP INDEX IF EXISTS "LegalSourceAnalysisCache_normalizedKeyword_jurisdiction_key";
ALTER TABLE "LegalSourceAnalysisCache" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "LegalSourceAnalysisCache" DROP COLUMN IF EXISTS "jurisdiction";
ALTER TABLE "LegalSourceAnalysisCache" DROP CONSTRAINT IF EXISTS "LegalSourceAnalysisCache_tenantId_fkey";
ALTER TABLE "LegalSourceAnalysisCache" ADD CONSTRAINT "LegalSourceAnalysisCache_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS "LegalSourceAnalysisCache_normalizedKeyword_tenantId_key"
  ON "LegalSourceAnalysisCache"("normalizedKeyword", "tenantId");

-- ── Drop the now-unreferenced enum ──────────────────────────────────────────
DROP TYPE IF EXISTS "Jurisdiction";
