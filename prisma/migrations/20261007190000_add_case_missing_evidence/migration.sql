-- CreateEnum
CREATE TYPE "MissingEvidenceSeverity" AS ENUM ('CRITICAL', 'MODERATE', 'MINOR');

-- CreateEnum
CREATE TYPE "MissingEvidenceStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "CaseMissingEvidence" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "claimId" TEXT,
    "label" TEXT NOT NULL,
    "detail" TEXT,
    "suggestedSource" TEXT,
    "severity" "MissingEvidenceSeverity" NOT NULL,
    "status" "MissingEvidenceStatus" NOT NULL DEFAULT 'OPEN',
    "resolutionNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "notes" TEXT,
    "lawyerEditedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseMissingEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaseMissingEvidence_caseId_idx" ON "CaseMissingEvidence"("caseId");

-- CreateIndex
CREATE INDEX "CaseMissingEvidence_claimId_idx" ON "CaseMissingEvidence"("claimId");

-- AddForeignKey
ALTER TABLE "CaseMissingEvidence" ADD CONSTRAINT "CaseMissingEvidence_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
