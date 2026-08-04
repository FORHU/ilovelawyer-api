INSERT INTO "Party" ("id", "caseId", "name", "designation")
SELECT gen_random_uuid(), "id", "partyInvolved", 'Petitioner / Plaintiff'
FROM "Case"
WHERE "partyInvolved" IS NOT NULL AND "partyInvolved" != '';

ALTER TABLE "Case" DROP COLUMN "partyInvolved";
