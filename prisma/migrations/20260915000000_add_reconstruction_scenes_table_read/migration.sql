-- Differentiation program, Phase 3 (Grounded Reconstruction, Rungs 1-2) — see
-- docs/plans/differentiation-program.md Workstream C. Additive only: new nullable columns plus
-- one new FK to File for the table-read audio clip (mirrors the existing audioFileId FK).
-- AlterTable
ALTER TABLE "CaseReconstruction" ADD COLUMN     "scenes" JSONB,
ADD COLUMN     "tableReadFileId" TEXT,
ADD COLUMN     "tableReadStatus" TEXT,
ADD COLUMN     "tableReadStaleAt" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "CaseReconstruction" ADD CONSTRAINT "CaseReconstruction_tableReadFileId_fkey" FOREIGN KEY ("tableReadFileId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;
