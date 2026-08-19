-- Enforce "a user belongs to at most one organization" at the DB level.
--
-- Must run only after any existing duplicate OrganizationMember rows for the
-- same userId have been removed (see scripts/fix-stewie-org-membership.ts) —
-- otherwise CREATE UNIQUE INDEX below fails on a uniqueness violation.

DROP INDEX "OrganizationMember_organizationId_userId_key";
DROP INDEX "OrganizationMember_userId_idx";
CREATE UNIQUE INDEX "OrganizationMember_userId_key" ON "OrganizationMember"("userId");
