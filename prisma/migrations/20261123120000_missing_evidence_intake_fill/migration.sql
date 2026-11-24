-- #159: links an intake-time evidence upload to the CaseMissingEvidence gap it resolved.
-- filledByDocumentId is a plain id, not a foreign key, mirroring claimId's own soft-reference
-- pattern on this table: a later document delete or case rescan must never orphan or block the
-- gap row it points at.
-- AlterTable
ALTER TABLE "CaseMissingEvidence"
  ADD COLUMN "filledByDocumentId" TEXT,
  ADD COLUMN "filledAt" TIMESTAMP(3),
  ADD COLUMN "filledViaIntake" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "CaseMissingEvidence_filledByDocumentId_idx" ON "CaseMissingEvidence"("filledByDocumentId");
