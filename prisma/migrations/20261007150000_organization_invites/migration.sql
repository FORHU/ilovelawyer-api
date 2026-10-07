-- Invitations move out of OrganizationMember into their own table. OrganizationMember allows one
-- row per user, so a PENDING invite there could only reach someone with no organization; kept
-- apart, a member of one organization can be invited to another and choose to switch.
CREATE TABLE "OrganizationInvite" (
    "id"             TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId"         TEXT NOT NULL,
    "role"           "OrganizationRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganizationInvite_userId_key" ON "OrganizationInvite"("userId");
CREATE INDEX "OrganizationInvite_organizationId_idx" ON "OrganizationInvite"("organizationId");

ALTER TABLE "OrganizationInvite" ADD CONSTRAINT "OrganizationInvite_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationInvite" ADD CONSTRAINT "OrganizationInvite_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry outstanding invites over (same ids, so nothing referencing them breaks), then drop the
-- PENDING membership rows they were stored as.
INSERT INTO "OrganizationInvite" ("id", "organizationId", "userId", "role", "createdAt")
SELECT "id", "organizationId", "userId", "role", "createdAt"
FROM "OrganizationMember"
WHERE "status" = 'PENDING';

DELETE FROM "OrganizationMember" WHERE "status" = 'PENDING';
