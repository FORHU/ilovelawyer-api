-- The lawyer's "the work is finished" waits for the client to confirm it (or closes by itself).
CREATE TYPE "CompletionConfirmedBy" AS ENUM ('CLIENT', 'AUTO');

ALTER TABLE "ClientRequest" ADD COLUMN "completionRequestedAt" TIMESTAMP(3),
ADD COLUMN "completionNote" TEXT,
ADD COLUMN "completionDeclinedAt" TIMESTAMP(3),
ADD COLUMN "completionDeclineReason" TEXT,
ADD COLUMN "completionConfirmedBy" "CompletionConfirmedBy";

CREATE INDEX "ClientRequest_status_completionRequestedAt_idx" ON "ClientRequest"("status", "completionRequestedAt");
