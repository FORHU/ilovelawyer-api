-- Deletions scheduled before FOR_DELETION existed were left ARCHIVED with deletionRequestedAt set.
-- Separate migration: Postgres won't use an enum value in the transaction that added it.
UPDATE "Consultation" SET "status" = 'FOR_DELETION' WHERE "status" = 'ARCHIVED' AND "deletionRequestedAt" IS NOT NULL;
