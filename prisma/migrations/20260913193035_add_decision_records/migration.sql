-- Differentiation program, Phase 1 (Decision Records) — see docs/plans/differentiation-program.md.
-- Postgres requires ALTER TYPE ... ADD VALUE to not be used in the same transaction that adds
-- it; nothing else in this migration references 'DECISION', so it's safe in one transaction.
-- AlterEnum
ALTER TYPE "CaseGraphNodeType" ADD VALUE 'DECISION';

-- CreateEnum
CREATE TYPE "DecisionStatus" AS ENUM ('ACTIVE', 'DISPUTED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "MessageDecisionRecord" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "records" JSONB NOT NULL,
    "verification" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageDecisionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecisionRecord" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "sourceMessageId" TEXT,
    "anchor" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "DecisionStatus" NOT NULL DEFAULT 'ACTIVE',
    "authorUserId" TEXT,
    "disputeNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DecisionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageDecisionRecord_messageId_key" ON "MessageDecisionRecord"("messageId");

-- CreateIndex
CREATE INDEX "DecisionRecord_caseId_idx" ON "DecisionRecord"("caseId");

-- CreateIndex
CREATE INDEX "DecisionRecord_caseId_status_idx" ON "DecisionRecord"("caseId", "status");

-- AddForeignKey
ALTER TABLE "MessageDecisionRecord" ADD CONSTRAINT "MessageDecisionRecord_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionRecord" ADD CONSTRAINT "DecisionRecord_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
