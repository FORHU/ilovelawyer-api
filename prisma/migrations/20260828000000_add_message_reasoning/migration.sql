-- CreateTable
CREATE TABLE "MessageReasoning" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "citationReasons" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageReasoning_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageReasoning_messageId_key" ON "MessageReasoning"("messageId");

-- AddForeignKey
ALTER TABLE "MessageReasoning" ADD CONSTRAINT "MessageReasoning_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
