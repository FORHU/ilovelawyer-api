-- This is the *second* time this index has been silently dropped by an unrelated
-- auto-generated `prisma migrate dev` reconciliation and needed restoring:
--   1. Created:  20260820133000_add_case_document_chunk_embedding_hnsw
--   2. Dropped:  20260821065915_add_organization_creator_and_package_sku (side effect)
--   3. Restored: 20260821071500_restore_case_document_chunk_hnsw_index
--   4. Dropped again: 20260825153126_ ("add MessageAudioOverview table" — the DROP INDEX
--      line has nothing to do with that table, it's the same drift-reconciliation bug)
--   5. Restored again: this migration.
--
-- Root cause: pgvector's HNSW/opclass index can't be expressed in schema.prisma, so
-- Prisma's schema-drift diffing doesn't know it's supposed to exist — any future
-- `prisma migrate dev` that touches CaseDocumentChunk risks dropping it a third time.
-- If retrieval (relevantChunksForCase/ForConsultation/ForDocument) ever looks like it's
-- doing a full sequential scan again, check `pg_indexes` for this index by name first.
CREATE INDEX IF NOT EXISTS "CaseDocumentChunk_embedding_hnsw_idx"
  ON "CaseDocumentChunk"
  USING hnsw (embedding vector_cosine_ops);
