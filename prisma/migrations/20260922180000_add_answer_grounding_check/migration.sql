-- CreateTable
CREATE TABLE "AnswerGroundingCheck" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "caseId" TEXT,
    "kind" TEXT NOT NULL,
    "assertion" TEXT NOT NULL,
    "citation" TEXT,
    "documentId" TEXT,
    "passage" TEXT,
    "verdict" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "evidenceKind" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnswerGroundingCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnswerGroundingCheck_messageId_idx" ON "AnswerGroundingCheck"("messageId");

-- CreateIndex
CREATE INDEX "AnswerGroundingCheck_caseId_verdict_idx" ON "AnswerGroundingCheck"("caseId", "verdict");

-- AddForeignKey
ALTER TABLE "AnswerGroundingCheck" ADD CONSTRAINT "AnswerGroundingCheck_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
