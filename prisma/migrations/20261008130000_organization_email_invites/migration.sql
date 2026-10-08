-- Invites to email addresses that have no account yet. Kept apart from OrganizationInvite (which
-- needs a userId); claimed into one when the address registers and verifies.
CREATE TABLE "OrganizationEmailInvite" (
    "id"             TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email"          TEXT NOT NULL,
    "role"           "OrganizationRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationEmailInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganizationEmailInvite_email_key" ON "OrganizationEmailInvite"("email");
CREATE INDEX "OrganizationEmailInvite_organizationId_idx" ON "OrganizationEmailInvite"("organizationId");

ALTER TABLE "OrganizationEmailInvite" ADD CONSTRAINT "OrganizationEmailInvite_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
