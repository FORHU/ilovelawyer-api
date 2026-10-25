-- The engagement thread between a client and their engaged lawyer (#517), and when each side last
-- read it.
-- CreateEnum
CREATE TYPE "EngagementMessageSide" AS ENUM ('CLIENT', 'LAWYER', 'SYSTEM');

-- AlterTable
ALTER TABLE "ClientRequest" ADD COLUMN "lawyerReadAt" TIMESTAMP(3),
ADD COLUMN "clientReadAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EngagementMessage" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "authorId" TEXT,
    "side" "EngagementMessageSide" NOT NULL,
    "body" TEXT NOT NULL,
    "documentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngagementMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EngagementMessage_requestId_createdAt_idx" ON "EngagementMessage"("requestId", "createdAt");
CREATE INDEX "EngagementMessage_authorId_idx" ON "EngagementMessage"("authorId");

-- AddForeignKey
ALTER TABLE "EngagementMessage" ADD CONSTRAINT "EngagementMessage_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ClientRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EngagementMessage" ADD CONSTRAINT "EngagementMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EngagementMessage" ADD CONSTRAINT "EngagementMessage_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
