-- RenameTable
ALTER TABLE "UserDocument" RENAME TO "CaseDocument";
ALTER TABLE "CaseDocument" RENAME CONSTRAINT "UserDocument_pkey" TO "CaseDocument_pkey";
ALTER TABLE "CaseDocument" RENAME CONSTRAINT "UserDocument_userId_fkey" TO "CaseDocument_userId_fkey";
ALTER TABLE "CaseDocument" RENAME CONSTRAINT "UserDocument_caseId_fkey" TO "CaseDocument_caseId_fkey";
ALTER TABLE "CaseDocument" RENAME CONSTRAINT "UserDocument_fileId_fkey" TO "CaseDocument_fileId_fkey";
ALTER INDEX "UserDocument_userId_idx" RENAME TO "CaseDocument_userId_idx";

-- RenameColumn
ALTER TABLE "CaseDocumentChunk" RENAME COLUMN "userDocumentId" TO "caseDocumentId";
ALTER TABLE "CaseDocumentChunk" RENAME CONSTRAINT "CaseDocumentChunk_userDocumentId_fkey" TO "CaseDocumentChunk_caseDocumentId_fkey";
ALTER INDEX "CaseDocumentChunk_userDocumentId_idx" RENAME TO "CaseDocumentChunk_caseDocumentId_idx";
