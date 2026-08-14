-- AlterTable
ALTER TABLE "Transcription" ADD COLUMN "consultationId" TEXT;
ALTER TABLE "Transcription" ADD COLUMN "ragStatus" "RagStatus" NOT NULL DEFAULT 'PENDING';

-- CreateIndex
CREATE INDEX "Transcription_consultationId_idx" ON "Transcription"("consultationId");

-- AddForeignKey
ALTER TABLE "Transcription" ADD CONSTRAINT "Transcription_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "Consultation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "TranscriptionChunk" (
    "id" TEXT NOT NULL,
    "transcriptionId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "chunkText" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranscriptionChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TranscriptionChunk_transcriptionId_idx" ON "TranscriptionChunk"("transcriptionId");

-- AddForeignKey
ALTER TABLE "TranscriptionChunk" ADD CONSTRAINT "TranscriptionChunk_transcriptionId_fkey" FOREIGN KEY ("transcriptionId") REFERENCES "Transcription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
