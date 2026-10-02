CREATE TABLE "MessageCitationRanking" (
  "id"        TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "items"     JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageCitationRanking_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MessageCitationRanking_messageId_key" ON "MessageCitationRanking"("messageId");

ALTER TABLE "MessageCitationRanking" ADD CONSTRAINT "MessageCitationRanking_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
