-- AlterTable
ALTER TABLE "TerminalWorkspace" ADD COLUMN     "caseId" TEXT;

-- CreateIndex
CREATE INDEX "TerminalWorkspace_caseId_idx" ON "TerminalWorkspace"("caseId");

-- AddForeignKey
ALTER TABLE "TerminalWorkspace" ADD CONSTRAINT "TerminalWorkspace_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
