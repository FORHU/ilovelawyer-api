-- AlterTable
ALTER TABLE "User" ADD COLUMN     "trialExpiresAt" TIMESTAMP(3),
ADD COLUMN     "trialMessagesUsed" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "User_trialExpiresAt_idx" ON "User"("trialExpiresAt");
