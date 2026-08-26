-- CreateEnum
CREATE TYPE "AudioOverviewStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');

-- DropIndex
DROP INDEX "CaseDocumentChunk_embedding_hnsw_idx";

-- CreateTable
CREATE TABLE "MessageAudioOverview" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "turns" JSONB NOT NULL,
    "voiceHostA" TEXT NOT NULL,
    "voiceHostB" TEXT NOT NULL,
    "audioFileId" TEXT,
    "audioStatus" "AudioOverviewStatus",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageAudioOverview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageAudioOverview_messageId_key" ON "MessageAudioOverview"("messageId");

-- AddForeignKey
ALTER TABLE "MessageAudioOverview" ADD CONSTRAINT "MessageAudioOverview_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAudioOverview" ADD CONSTRAINT "MessageAudioOverview_audioFileId_fkey" FOREIGN KEY ("audioFileId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;
