-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CaseGraphNodeType" ADD VALUE 'WITNESS';
ALTER TYPE "CaseGraphNodeType" ADD VALUE 'DOCUMENT';
ALTER TYPE "CaseGraphNodeType" ADD VALUE 'PARTY';
ALTER TYPE "CaseGraphNodeType" ADD VALUE 'DAMAGE_CLAIM';
ALTER TYPE "CaseGraphNodeType" ADD VALUE 'FINDING';
ALTER TYPE "CaseGraphNodeType" ADD VALUE 'CLAIM';

-- CreateTable
CREATE TABLE "CaseClaim" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "causeOfAction" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaseClaim_caseId_idx" ON "CaseClaim"("caseId");

-- AddForeignKey
ALTER TABLE "CaseClaim" ADD CONSTRAINT "CaseClaim_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
