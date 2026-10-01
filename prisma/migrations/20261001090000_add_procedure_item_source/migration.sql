-- AlterTable
ALTER TABLE "ProcedureItem" ADD COLUMN "sourceKind" TEXT,
ADD COLUMN "sourceId" TEXT,
ADD COLUMN "sourceKey" TEXT,
ADD COLUMN "autoClosedAt" TIMESTAMP(3),
ADD COLUMN "autoClosedReason" TEXT;

-- CreateIndex
CREATE INDEX "ProcedureItem_caseId_sourceKind_sourceId_idx" ON "ProcedureItem"("caseId", "sourceKind", "sourceId");
