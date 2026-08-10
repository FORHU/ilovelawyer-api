-- Enable pgvector for the embedding column below
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "CaseDocumentChunk" (
    "id" TEXT NOT NULL,
    "userDocumentId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "chunkText" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseDocumentChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaseDocumentChunk_userDocumentId_idx" ON "CaseDocumentChunk"("userDocumentId");

-- AddForeignKey
ALTER TABLE "CaseDocumentChunk" ADD CONSTRAINT "CaseDocumentChunk_userDocumentId_fkey" FOREIGN KEY ("userDocumentId") REFERENCES "UserDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
