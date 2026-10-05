-- AlterTable
ALTER TABLE "Consultation" ADD COLUMN     "deletionRequestedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Consultation_deletionRequestedAt_idx" ON "Consultation"("deletionRequestedAt");
