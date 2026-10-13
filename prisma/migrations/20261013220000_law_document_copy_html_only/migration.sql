-- Law document copies are only ever legislation.gov.uk's HTML now, never a PDF, so "format" is
-- dropped. Every saved copy at this point was HTML.

-- AlterTable
ALTER TABLE "LawDocumentCopy" DROP COLUMN "format";
