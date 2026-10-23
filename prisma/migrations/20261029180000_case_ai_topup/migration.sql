-- CreateEnum
CREATE TYPE "CaseAiTopUpStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "CaseAiTopUp" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "topUpAmountUsd" DOUBLE PRECISION NOT NULL,
    "feeAmountUsd" DOUBLE PRECISION NOT NULL,
    "totalChargedUsd" DOUBLE PRECISION NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT,
    "status" "CaseAiTopUpStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "grantedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseAiTopUp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaseAiTopUp_externalId_idx" ON "CaseAiTopUp"("externalId");

-- CreateIndex
CREATE INDEX "CaseAiTopUp_caseId_idx" ON "CaseAiTopUp"("caseId");

-- AddForeignKey
ALTER TABLE "CaseAiTopUp" ADD CONSTRAINT "CaseAiTopUp_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseAiTopUp" ADD CONSTRAINT "CaseAiTopUp_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
