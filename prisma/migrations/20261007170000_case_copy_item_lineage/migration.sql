-- Item-level lineage for portfolio copies: each copied party, document, consultation, event and
-- timeline entry remembers the original item it came from, so a copy can later be compared with
-- (and selectively merged back into) its original. Copies made before this have none.
ALTER TABLE "Party" ADD COLUMN "copiedFromId" TEXT;
ALTER TABLE "Document" ADD COLUMN "copiedFromId" TEXT;
ALTER TABLE "Consultation" ADD COLUMN "copiedFromId" TEXT;
ALTER TABLE "CaseTimelineEvent" ADD COLUMN "copiedFromId" TEXT;
ALTER TABLE "events" ADD COLUMN "copied_from_id" TEXT;
