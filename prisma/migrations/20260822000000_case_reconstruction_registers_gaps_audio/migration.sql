-- AlterTable
ALTER TABLE "CaseReconstruction" ADD COLUMN "narrativeCourt" TEXT;
ALTER TABLE "CaseReconstruction" ADD COLUMN "narrativeOpposing" TEXT;
ALTER TABLE "CaseReconstruction" ADD COLUMN "gaps" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "CaseReconstruction" ADD COLUMN "audioFileId" TEXT;
ALTER TABLE "CaseReconstruction" ADD COLUMN "audioJobName" TEXT;
ALTER TABLE "CaseReconstruction" ADD COLUMN "audioStatus" TEXT;
ALTER TABLE "CaseReconstruction" ADD COLUMN "audioStaleAt" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "CaseReconstruction" ADD CONSTRAINT "CaseReconstruction_audioFileId_fkey" FOREIGN KEY ("audioFileId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;
