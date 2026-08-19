-- ============================================================================
-- Organization multi-tenancy: schema + transactional backfill.
--
-- Runs in four phases so existing rows are never left pointing at a NULL/
-- dangling organizationId between steps:
--   1. Create Organization / OrganizationMember + nullable organizationId
--      columns on the six resource tables.
--   2. Backfill: one "Default Organization", one OrganizationMember per
--      existing User (global ADMIN -> OWNER, everyone else -> MEMBER), then
--      stamp every existing resource row with that org's id.
--   3. De-duplicate Bookmark rows that would collide under the new
--      (organizationId, itemId) uniqueness (see note below).
--   4. Enforce NOT NULL + add FKs/indexes now that every row is populated.
--
-- Wrapped in a single transaction (Prisma runs each migration.sql this way
-- by default) so a failure at any phase leaves the DB untouched.
-- ============================================================================

-- ── Phase 1: schema ─────────────────────────────────────────────────────────

CREATE TYPE "OrganizationRole" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'MEMBER');

CREATE TABLE "Organization" (
    "id"        TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "slug"      TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

CREATE TABLE "OrganizationMember" (
    "id"             TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId"         TEXT NOT NULL,
    "role"           "OrganizationRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganizationMember_organizationId_userId_key" ON "OrganizationMember"("organizationId", "userId");
CREATE INDEX "OrganizationMember_userId_idx" ON "OrganizationMember"("userId");
CREATE INDEX "OrganizationMember_organizationId_idx" ON "OrganizationMember"("organizationId");

ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Nullable for now — populated in Phase 2, locked to NOT NULL in Phase 4.
ALTER TABLE "Case" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Document" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Consultation" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Bookmark" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "events" ADD COLUMN "organization_id" TEXT;
ALTER TABLE "Transcription" ADD COLUMN "organizationId" TEXT;

-- ── Phase 2: backfill ────────────────────────────────────────────────────────

DO $$
DECLARE
    default_org_id TEXT := gen_random_uuid()::TEXT;
BEGIN
    INSERT INTO "Organization" ("id", "name", "slug", "createdAt", "updatedAt")
    VALUES (default_org_id, 'Default Organization', 'default', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

    -- One membership per existing user. Global ADMIN becomes org OWNER (keeps
    -- today's "admins can manage everything" behavior); everyone else lands
    -- as MEMBER, the safe default a real admin can promote from later.
    INSERT INTO "OrganizationMember" ("id", "organizationId", "userId", "role", "createdAt", "updatedAt")
    SELECT
        gen_random_uuid()::TEXT,
        default_org_id,
        "id",
        CASE WHEN "role" = 'ADMIN' THEN 'OWNER'::"OrganizationRole" ELSE 'MEMBER'::"OrganizationRole" END,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    FROM "User";

    UPDATE "Case" SET "organizationId" = default_org_id WHERE "organizationId" IS NULL;
    UPDATE "Document" SET "organizationId" = default_org_id WHERE "organizationId" IS NULL;
    UPDATE "Consultation" SET "organizationId" = default_org_id WHERE "organizationId" IS NULL;
    UPDATE "Bookmark" SET "organizationId" = default_org_id WHERE "organizationId" IS NULL;
    UPDATE "events" SET "organization_id" = default_org_id WHERE "organization_id" IS NULL;
    UPDATE "Transcription" SET "organizationId" = default_org_id WHERE "organizationId" IS NULL;
END $$;

-- ── Phase 3: Bookmark de-duplication ────────────────────────────────────────
-- Bookmark's uniqueness moves from (userId, itemId) to (organizationId, itemId)
-- because it's now a shared org resource (see prisma/schema.prisma comment).
-- Backfilling every row into one org can surface pre-existing collisions:
-- two different users had bookmarked the same itemId, which was fine under
-- the old per-user constraint but violates the new per-org one. Keep the
-- oldest bookmark for each (organizationId, itemId) pair and drop the rest
-- before the new unique index is created.
DELETE FROM "Bookmark" b
USING (
    SELECT "id",
           ROW_NUMBER() OVER (PARTITION BY "organizationId", "itemId" ORDER BY "createdAt" ASC, "id" ASC) AS rn
    FROM "Bookmark"
) dupes
WHERE b."id" = dupes."id" AND dupes.rn > 1;

-- ── Phase 4: enforce constraints ────────────────────────────────────────────

ALTER TABLE "Case" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Document" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Consultation" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Bookmark" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "events" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "Transcription" ALTER COLUMN "organizationId" SET NOT NULL;

ALTER TABLE "Case" ADD CONSTRAINT "Case_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Document" ADD CONSTRAINT "Document_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Consultation" ADD CONSTRAINT "Consultation_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Bookmark" ADD CONSTRAINT "Bookmark_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "events" ADD CONSTRAINT "events_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Transcription" ADD CONSTRAINT "Transcription_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Case_organizationId_idx" ON "Case"("organizationId");
CREATE INDEX "Document_organizationId_idx" ON "Document"("organizationId");
CREATE INDEX "Consultation_organizationId_idx" ON "Consultation"("organizationId");
CREATE INDEX "Bookmark_organizationId_idx" ON "Bookmark"("organizationId");
CREATE INDEX "events_organization_id_idx" ON "events"("organization_id");
CREATE INDEX "Transcription_organizationId_idx" ON "Transcription"("organizationId");

-- Bookmark uniqueness: drop the old per-user constraint, add the new per-org one.
DROP INDEX "Bookmark_userId_itemId_key";
CREATE UNIQUE INDEX "Bookmark_organizationId_itemId_key" ON "Bookmark"("organizationId", "itemId");
