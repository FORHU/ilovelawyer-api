-- PDFs we print from saved legislation HTML (UK_LEGISLATION_PDF): a printed copy points at the HTML copy
-- it came from; HTML copies track their print attempts and a lease.

-- AlterTable
ALTER TABLE "LawDocumentCopy" ADD COLUMN     "printAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "printStartedAt" TIMESTAMP(3),
ADD COLUMN     "printedFromId" TEXT;

-- AddForeignKey
ALTER TABLE "LawDocumentCopy" ADD CONSTRAINT "LawDocumentCopy_printedFromId_fkey" FOREIGN KEY ("printedFromId") REFERENCES "LawDocumentCopy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

