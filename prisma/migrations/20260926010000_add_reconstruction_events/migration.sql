-- CreateTable
CREATE TABLE "CaseReconstructionEvents" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "events" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseReconstructionEvents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CaseReconstructionEvents_caseId_key" ON "CaseReconstructionEvents"("caseId");

-- AddForeignKey
ALTER TABLE "CaseReconstructionEvents" ADD CONSTRAINT "CaseReconstructionEvents_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

