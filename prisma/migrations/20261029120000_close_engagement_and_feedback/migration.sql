-- Close engagement and client feedback (ilovelawyer-api#519).
-- CreateEnum
CREATE TYPE "ClosedBy" AS ENUM ('LAWYER', 'CLIENT');

-- AlterTable
ALTER TABLE "ClientRequest" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "closedBy" "ClosedBy";

-- CreateTable
CREATE TABLE "EngagementFeedback" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngagementFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EngagementFeedback_requestId_key" ON "EngagementFeedback"("requestId");

-- AddForeignKey
ALTER TABLE "EngagementFeedback" ADD CONSTRAINT "EngagementFeedback_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ClientRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
