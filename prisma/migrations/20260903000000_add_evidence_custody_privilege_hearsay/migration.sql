-- CreateEnum
CREATE TYPE "PrivilegeStatus" AS ENUM ('NONE', 'ATTORNEY_CLIENT', 'WORK_PRODUCT');

-- CreateEnum
CREATE TYPE "HearsayCategory" AS ENUM ('DIRECT_EVIDENCE', 'BUSINESS_RECORD', 'PRESENT_SENSE_IMPRESSION', 'EXCITED_UTTERANCE', 'OTHER_EXCEPTION', 'NOT_APPLICABLE');

-- AlterTable
ALTER TABLE "EvidenceMatrixItem" ADD COLUMN     "hearsayCategory" "HearsayCategory" NOT NULL DEFAULT 'NOT_APPLICABLE',
ADD COLUMN     "privilegeStatus" "PrivilegeStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "sponsoringWitnessId" TEXT;

-- CreateTable
CREATE TABLE "EvidenceCustodyEvent" (
    "id" TEXT NOT NULL,
    "evidenceMatrixItemId" TEXT NOT NULL,
    "custodianName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceCustodyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EvidenceCustodyEvent_evidenceMatrixItemId_idx" ON "EvidenceCustodyEvent"("evidenceMatrixItemId");

-- CreateIndex
CREATE INDEX "EvidenceMatrixItem_sponsoringWitnessId_idx" ON "EvidenceMatrixItem"("sponsoringWitnessId");

-- AddForeignKey
ALTER TABLE "EvidenceMatrixItem" ADD CONSTRAINT "EvidenceMatrixItem_sponsoringWitnessId_fkey" FOREIGN KEY ("sponsoringWitnessId") REFERENCES "Witness"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceCustodyEvent" ADD CONSTRAINT "EvidenceCustodyEvent_evidenceMatrixItemId_fkey" FOREIGN KEY ("evidenceMatrixItemId") REFERENCES "EvidenceMatrixItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
