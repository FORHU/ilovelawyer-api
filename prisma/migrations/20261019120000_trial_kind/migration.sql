-- CreateEnum
CREATE TYPE "TrialKind" AS ENUM ('CHAT', 'FULL');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "trialKind" "TrialKind";

-- Every guest so far is on the chat-only trial, the only one there was.
UPDATE "User" SET "trialKind" = 'CHAT' WHERE "trialExpiresAt" IS NOT NULL;
