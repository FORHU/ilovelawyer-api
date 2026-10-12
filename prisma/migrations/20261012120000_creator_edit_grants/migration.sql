-- A MANAGER/MEMBER now gets an EDIT grant on the cases they create (CaseSvc.create). Give the
-- same to the creators of existing organization cases, so they can work on matters they already
-- made. Only ordinary cases: a confidential case's access was chosen on purpose, so it's left as
-- it is. Creators who have left the organization, and anyone already holding a grant, are skipped.
INSERT INTO "CaseAccess" ("id", "caseId", "userId", "permission", "createdAt")
SELECT gen_random_uuid()::text, c."id", c."userId", 'EDIT', NOW()
FROM "Case" c
JOIN "Organization" o ON o."id" = c."organizationId" AND o."isPersonal" = false
JOIN "OrganizationMember" m
  ON m."organizationId" = c."organizationId"
 AND m."userId" = c."userId"
 AND m."status" = 'ACCEPTED'
 AND m."role" IN ('MANAGER', 'MEMBER')
WHERE c."confidential" = false
ON CONFLICT ("caseId", "userId") DO NOTHING;
