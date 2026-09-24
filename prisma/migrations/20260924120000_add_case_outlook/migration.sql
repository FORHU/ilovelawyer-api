-- CreateEnum
CREATE TYPE "OutlookBand" AS ENUM ('FAVORABLE', 'LEANS_FAVORABLE', 'UNCERTAIN', 'LEANS_UNFAVORABLE', 'UNFAVORABLE');

-- CreateEnum
CREATE TYPE "ConfidenceLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- AlterTable
ALTER TABLE "Party" ADD COLUMN "descriptor" TEXT;

-- AlterTable
ALTER TABLE "CaseRisk" ADD COLUMN "confidence" "ConfidenceLevel";

-- CreateTable
CREATE TABLE "CaseOutlook" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "band" "OutlookBand" NOT NULL,
    "confidence" "ConfidenceLevel" NOT NULL,
    "rationale" TEXT NOT NULL,
    "drivers" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseOutlook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaseOutlook_caseId_createdAt_idx" ON "CaseOutlook"("caseId", "createdAt");

-- AddForeignKey
ALTER TABLE "CaseOutlook" ADD CONSTRAINT "CaseOutlook_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
