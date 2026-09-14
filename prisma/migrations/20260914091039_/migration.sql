-- DropIndex
DROP INDEX "CaseDocumentChunk_embedding_hnsw_idx";

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "isExhibit" BOOLEAN NOT NULL DEFAULT false;
