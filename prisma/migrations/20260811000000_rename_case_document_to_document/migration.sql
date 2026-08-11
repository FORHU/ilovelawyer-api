-- The schema.prisma model was renamed from CaseDocument to Document. This brings the actual
-- DB objects in line with the current schema via RENAME, not drop/recreate, so existing data
-- and the CaseDocumentChunk FK relationship are preserved.

-- RenameTable
ALTER TABLE "CaseDocument" RENAME TO "Document";
ALTER TABLE "Document" RENAME CONSTRAINT "CaseDocument_pkey" TO "Document_pkey";

-- RenameIndex
ALTER INDEX "CaseDocument_userId_idx" RENAME TO "Document_userId_idx";

-- RenameForeignKey
ALTER TABLE "Document" RENAME CONSTRAINT "CaseDocument_userId_fkey" TO "Document_userId_fkey";
ALTER TABLE "Document" RENAME CONSTRAINT "CaseDocument_caseId_fkey" TO "Document_caseId_fkey";
ALTER TABLE "Document" RENAME CONSTRAINT "CaseDocument_fileId_fkey" TO "Document_fileId_fkey";
