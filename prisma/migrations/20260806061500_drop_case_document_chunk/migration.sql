-- DropTable
DROP TABLE "CaseDocumentChunk";

-- AlterTable
ALTER TABLE "CaseDocument" DROP COLUMN "ragStatus";

-- DropEnum
DROP TYPE "RagStatus";

-- Note: the "vector" extension (enabled in migration 20260806053055) is left in place —
-- legal-rag's externally-owned document_chunks table also relies on it.
