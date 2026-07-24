ALTER TABLE "Conversation" ADD COLUMN "caseId" TEXT;

CREATE INDEX "Conversation_caseId_idx" ON "Conversation"("caseId");

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;
