-- NOTE: prisma migrate dev's drift-diffing auto-generated a `DROP INDEX
-- "CaseDocumentChunk_embedding_hnsw_idx"` here as an unrelated side effect of this
-- schema change, because pgvector's HNSW index isn't expressible in schema.prisma.
-- This is the same recurring bug documented in
-- 20260909234409_restore_case_document_chunk_hnsw_index_again/migration.sql — the
-- DROP INDEX line has been removed so it doesn't happen a 4th time.

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "isExhibit" BOOLEAN NOT NULL DEFAULT false;
