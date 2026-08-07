-- The schema.prisma model was renamed from UserDocument to CaseDocument without a matching
-- migration (see git history: af89fda rename -> 9a72b52 revert -> 88dd028 re-rename, same day).
-- This brings the actual DB objects in line with the current schema via RENAME, not drop/recreate,
-- so existing data and the CaseDocumentChunk FK relationship are preserved.

-- RenameTable
ALTER TABLE "UserDocument" RENAME TO "CaseDocument";
ALTER TABLE "CaseDocument" RENAME CONSTRAINT "UserDocument_pkey" TO "CaseDocument_pkey";

-- RenameIndex
ALTER INDEX "UserDocument_userId_idx" RENAME TO "CaseDocument_userId_idx";

-- RenameForeignKey
ALTER TABLE "CaseDocument" RENAME CONSTRAINT "UserDocument_userId_fkey" TO "CaseDocument_userId_fkey";
ALTER TABLE "CaseDocument" RENAME CONSTRAINT "UserDocument_caseId_fkey" TO "CaseDocument_caseId_fkey";
ALTER TABLE "CaseDocument" RENAME CONSTRAINT "UserDocument_fileId_fkey" TO "CaseDocument_fileId_fkey";

-- RenameColumn
ALTER TABLE "CaseDocumentChunk" RENAME COLUMN "userDocumentId" TO "caseDocumentId";

-- RenameIndex
ALTER INDEX "CaseDocumentChunk_userDocumentId_idx" RENAME TO "CaseDocumentChunk_caseDocumentId_idx";

-- RenameForeignKey
ALTER TABLE "CaseDocumentChunk" RENAME CONSTRAINT "CaseDocumentChunk_userDocumentId_fkey" TO "CaseDocumentChunk_caseDocumentId_fkey";
