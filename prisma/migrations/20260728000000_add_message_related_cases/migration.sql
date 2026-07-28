CREATE TABLE "MessageRelatedCases" (
  "id"        TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "items"     JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageRelatedCases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MessageRelatedCases_messageId_key" ON "MessageRelatedCases"("messageId");

ALTER TABLE "MessageRelatedCases" ADD CONSTRAINT "MessageRelatedCases_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
