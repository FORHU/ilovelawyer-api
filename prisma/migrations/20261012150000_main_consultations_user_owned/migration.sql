-- A main (standalone, case-less) consultation belongs to its user, not to the workspace it was
-- started in. Stored under an organization, it vanished from the user's list the moment they
-- joined another one. From here on it carries no organization, so joining, switching or leaving
-- an organization can't hide, move or copy it. A case's consultation keeps the case's organization.

ALTER TABLE "Consultation" ALTER COLUMN "organizationId" DROP NOT NULL;
-- Files attached to a main consultation follow it.
ALTER TABLE "Document" ALTER COLUMN "organizationId" DROP NOT NULL;

CREATE INDEX "Consultation_userId_caseId_status_idx" ON "Consultation"("userId", "caseId", "status");

-- Rollback path: where each main consultation lived before this migration.
CREATE TABLE "consultation_org_backup" AS
SELECT "id", "organizationId", NOW() AS "detachedAt"
FROM "Consultation"
WHERE "caseId" IS NULL AND "organizationId" IS NOT NULL;

-- Leaving an organization used to copy a member's main consultations into their portfolio, so
-- someone who left already has the same chat twice (the original stays with the organization they
-- can no longer open). Detached, both would be listed. Keep whichever has more messages — a
-- copy that was carried on in the portfolio is the newer one — and the original on a tie.
WITH pairs AS (
  SELECT
    c."id" AS copy_id,
    o."id" AS original_id,
    (SELECT COUNT(*) FROM "Message" m WHERE m."consultationId" = c."id") AS copy_messages,
    (SELECT COUNT(*) FROM "Message" m WHERE m."consultationId" = o."id") AS original_messages
  FROM "Consultation" c
  JOIN "Consultation" o
    ON o."id" = c."copiedFromId"
   AND o."userId" = c."userId"
   AND o."caseId" IS NULL
  WHERE c."caseId" IS NULL
)
DELETE FROM "Consultation"
WHERE "id" IN (
  SELECT CASE WHEN copy_messages > original_messages THEN original_id ELSE copy_id END FROM pairs
);

-- Detach every main consultation, and the files attached to it.
UPDATE "Consultation" SET "organizationId" = NULL WHERE "caseId" IS NULL;

UPDATE "Document" d
SET "organizationId" = NULL
FROM "Consultation" c
WHERE d."consultationId" = c."id"
  AND d."caseId" IS NULL
  AND c."caseId" IS NULL;

-- Copies of main consultations still queued would now create duplicates; there is nothing to copy.
UPDATE "ConsultationCopy"
SET "status" = 'DONE', "error" = 'Main consultations no longer copy when leaving an organization'
WHERE "status" IN ('PENDING', 'RUNNING');
