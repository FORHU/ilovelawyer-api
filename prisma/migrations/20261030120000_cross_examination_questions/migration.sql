-- CreateEnum
CREATE TYPE "WitnessSide" AS ENUM ('OURS', 'THEIRS');

-- CreateEnum
CREATE TYPE "CrossExamStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'REJECTED');

-- AlterTable
ALTER TABLE "Witness" ADD COLUMN     "calledBy" "WitnessSide";

-- CreateTable
CREATE TABLE "CrossExamQuestion" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "witnessId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "purpose" TEXT,
    "position" INTEGER NOT NULL,
    "sourceDocumentId" TEXT,
    "sourceQuote" TEXT NOT NULL,
    "pageNumber" INTEGER,
    "supportVerdict" TEXT,
    "supportConfidence" DOUBLE PRECISION,
    "status" "CrossExamStatus" NOT NULL DEFAULT 'PROPOSED',
    "lawyerEditedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrossExamQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrossExamQuestion_caseId_idx" ON "CrossExamQuestion"("caseId");

-- CreateIndex
CREATE INDEX "CrossExamQuestion_witnessId_idx" ON "CrossExamQuestion"("witnessId");

-- AddForeignKey
ALTER TABLE "CrossExamQuestion" ADD CONSTRAINT "CrossExamQuestion_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrossExamQuestion" ADD CONSTRAINT "CrossExamQuestion_witnessId_fkey" FOREIGN KEY ("witnessId") REFERENCES "Witness"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrossExamQuestion" ADD CONSTRAINT "CrossExamQuestion_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

