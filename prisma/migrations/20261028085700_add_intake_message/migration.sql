-- CreateEnum
CREATE TYPE "IntakeMessageRole" AS ENUM ('user', 'assistant', 'system');

-- CreateEnum
CREATE TYPE "IntakeMessageReplyStatus" AS ENUM ('PENDING', 'DONE', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "IntakeMessage" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "role" "IntakeMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "replyStatus" "IntakeMessageReplyStatus",
    "pendingReplyContent" TEXT,
    "documentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "findLawyerResultIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "markedReady" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "IntakeMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntakeMessage_caseId_idx" ON "IntakeMessage"("caseId");

-- CreateIndex
CREATE INDEX "IntakeMessage_userId_idx" ON "IntakeMessage"("userId");

-- AddForeignKey
ALTER TABLE "IntakeMessage" ADD CONSTRAINT "IntakeMessage_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
