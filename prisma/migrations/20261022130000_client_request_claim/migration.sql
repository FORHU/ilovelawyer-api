-- The claim on a client request (#511): one lawyer's 24h hold, and when the request was last
-- routed and announced. See ClientRequestClaim in schema.prisma.

-- CreateEnum
CREATE TYPE "ClaimOutcome" AS ENUM ('RELEASED', 'LAPSED', 'DECLINED', 'REASSIGNED', 'WITHDRAWN', 'ENGAGED');

-- AlterTable
ALTER TABLE "ClientRequest" ADD COLUMN     "announcedAt" TIMESTAMP(3),
ADD COLUMN     "routedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ClientRequestClaim" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "openRequestId" TEXT,
    "lawyerId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "reminderSentAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "outcome" "ClaimOutcome",

    CONSTRAINT "ClientRequestClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientRequestClaim_openRequestId_key" ON "ClientRequestClaim"("openRequestId");

-- CreateIndex
CREATE INDEX "ClientRequestClaim_requestId_idx" ON "ClientRequestClaim"("requestId");

-- CreateIndex
CREATE INDEX "ClientRequestClaim_lawyerId_outcome_idx" ON "ClientRequestClaim"("lawyerId", "outcome");

-- CreateIndex
CREATE INDEX "ClientRequestClaim_outcome_expiresAt_idx" ON "ClientRequestClaim"("outcome", "expiresAt");

-- AddForeignKey
ALTER TABLE "ClientRequestClaim" ADD CONSTRAINT "ClientRequestClaim_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ClientRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientRequestClaim" ADD CONSTRAINT "ClientRequestClaim_lawyerId_fkey" FOREIGN KEY ("lawyerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientRequestClaim" ADD CONSTRAINT "ClientRequestClaim_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Requests routed before this column existed: routing set routingExpiresAt to 48h after it.
UPDATE "ClientRequest" SET "routedAt" = "routingExpiresAt" - INTERVAL '48 hours' WHERE "routingExpiresAt" IS NOT NULL;
