-- The client's "I don't have this" on a suggested proof (the evidence step after the questions).
-- Kept apart from the lawyer's DISMISSED status: the gap stays OPEN for the lawyer to ask about.
-- AlterTable
ALTER TABLE "CaseMissingEvidence" ADD COLUMN "clientDismissedAt" TIMESTAMP(3);
