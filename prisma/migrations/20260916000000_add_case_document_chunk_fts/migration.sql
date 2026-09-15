-- Full-text column for hybrid (lexical + vector) chunk retrieval.
-- STORED generated column: Postgres computes it for every existing row at ALTER time
-- (table rewrite) and keeps it in sync on insert/update — no app-side maintenance.
ALTER TABLE "CaseDocumentChunk"
  ADD COLUMN "chunkTsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', "chunkText")) STORED;

CREATE INDEX "CaseDocumentChunk_chunkTsv_idx"
  ON "CaseDocumentChunk"
  USING gin ("chunkTsv");
