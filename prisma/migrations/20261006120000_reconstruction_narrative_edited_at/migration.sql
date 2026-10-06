-- CaseReconstruction.narrativeEditedAt: when a lawyer last edited the narrative. While set, the
-- analysis refresh does not regenerate it. Existing rows start as NULL (treated as untouched).
ALTER TABLE "CaseReconstruction" ADD COLUMN "narrativeEditedAt" TIMESTAMP(3);
