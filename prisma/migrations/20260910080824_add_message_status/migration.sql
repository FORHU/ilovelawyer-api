-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('PENDING', 'COMPLETE', 'FAILED');

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "status" "MessageStatus" NOT NULL DEFAULT 'COMPLETE';

-- NOTE: `prisma migrate dev` also generated a `DROP INDEX "CaseDocumentChunk_embedding_hnsw_idx"`
-- line here — the same pgvector HNSW schema-drift bug documented in
-- 20260821071500_restore_case_document_chunk_hnsw_index and again in
-- 20260909234409_restore_case_document_chunk_hnsw_index_again (the index can't be expressed in
-- schema.prisma, so every migrate dev that touches an unrelated table wants to drop it). It has
-- been removed by hand so this migration never drops that index on deploy. The line below
-- re-asserts it for safety.
CREATE INDEX IF NOT EXISTS "CaseDocumentChunk_embedding_hnsw_idx"
  ON "CaseDocumentChunk"
  USING hnsw (embedding vector_cosine_ops);
