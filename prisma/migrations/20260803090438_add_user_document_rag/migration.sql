-- Already present on this DB via legal-rag's own setup, but guarded in case this
-- migration is ever the first thing to run against a fresh database.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "UserDocumentRagStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "UserDocument" ADD COLUMN     "ragStatus" "UserDocumentRagStatus" NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "UserDocumentChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "chunkText" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserDocumentChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserDocumentChunk_documentId_idx" ON "UserDocumentChunk"("documentId");

-- CreateIndex (cosine distance — matches the `<=>` operator used in vector search queries)
CREATE INDEX "UserDocumentChunk_embedding_idx" ON "UserDocumentChunk"
  USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);

-- AddForeignKey
ALTER TABLE "UserDocumentChunk" ADD CONSTRAINT "UserDocumentChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "UserDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
