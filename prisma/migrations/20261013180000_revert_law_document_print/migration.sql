-- Reverts 20261013170000_law_document_print: PDF printing of saved legislation was taken back out.
-- No PDF copies had been printed, so nothing is lost.

-- DropForeignKey
ALTER TABLE "LawDocumentCopy" DROP CONSTRAINT "LawDocumentCopy_printedFromId_fkey";

-- AlterTable
ALTER TABLE "LawDocumentCopy" DROP COLUMN "printAttempts",
DROP COLUMN "printStartedAt",
DROP COLUMN "printedFromId";

