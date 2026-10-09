-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'PENDING_DELETION');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "archivedAt" TIMESTAMP(3),
ADD COLUMN "archivedById" TEXT,
ADD COLUMN "deletionScheduledAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Organization_status_deletionScheduledAt_idx" ON "Organization"("status", "deletionScheduledAt");

-- Organizations whose last member already left (before leaving archived them) get the same
-- 30-day grace period from today. A personal workspace with no member is a parked portfolio,
-- not an abandoned organization, so it's left alone.
UPDATE "Organization" o
SET "status" = 'PENDING_DELETION',
    "archivedAt" = (now() AT TIME ZONE 'UTC'),
    "deletionScheduledAt" = (now() AT TIME ZONE 'UTC') + INTERVAL '30 days'
WHERE o."isPersonal" = false
  AND NOT EXISTS (SELECT 1 FROM "OrganizationMember" m WHERE m."organizationId" = o."id");
