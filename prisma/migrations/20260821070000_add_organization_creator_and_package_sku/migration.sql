-- schema.prisma already declared `Organization.packageSku` and `Organization.createdById`
-- (added alongside the org-API work), but no migration ever created the columns, so every
-- `organization.create()` / any read touching those fields threw a Postgres "column does
-- not exist" error, surfacing to the frontend as a generic 500.
--
-- Two pre-existing local rows ("Default Organization" and a duplicate "Cruz Law Offices")
-- have no OrganizationMember and no dependent Case/Document/Consultation/Bookmark/
-- Transcription/events/IntegrationConnector rows (verified before writing this migration),
-- so there is no owner to backfill and nothing reachable through the app anyway — they are
-- dropped rather than backfilled with a placeholder owner.
DELETE FROM "Organization"
WHERE "id" NOT IN (SELECT DISTINCT "organizationId" FROM "OrganizationMember");

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN "packageSku" "PackageSku" NOT NULL DEFAULT 'PROFESSIONAL';
ALTER TABLE "Organization" ADD COLUMN "createdById" TEXT;

-- Backfill: the organization's OWNER member is its creator.
UPDATE "Organization" o
SET "createdById" = om."userId"
FROM "OrganizationMember" om
WHERE om."organizationId" = o.id AND om."role" = 'OWNER';

ALTER TABLE "Organization" ALTER COLUMN "createdById" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Organization_createdById_idx" ON "Organization"("createdById");

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
