-- CreateEnum
CREATE TYPE "ConsultationStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- AlterTable
ALTER TABLE "Consultation" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "status" "ConsultationStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateIndex
CREATE INDEX "Consultation_organizationId_caseId_status_idx" ON "Consultation"("organizationId", "caseId", "status");
