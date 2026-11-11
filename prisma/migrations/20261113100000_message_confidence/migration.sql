-- Confidence view (chat-wonder confidence.py): one sealed payload per assistant turn.
-- CreateTable
CREATE TABLE "MessageConfidence" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageConfidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageConfidence_messageId_key" ON "MessageConfidence"("messageId");

-- AddForeignKey
ALTER TABLE "MessageConfidence" ADD CONSTRAINT "MessageConfidence_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
