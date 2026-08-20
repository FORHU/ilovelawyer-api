-- Approximate nearest-neighbor index for chat retrieval
-- (ORDER BY embedding <=> $query LIMIT n). Cosine ops match <=> on vector(1536).
CREATE INDEX "CaseDocumentChunk_embedding_hnsw_idx"
  ON "CaseDocumentChunk"
  USING hnsw (embedding vector_cosine_ops);
