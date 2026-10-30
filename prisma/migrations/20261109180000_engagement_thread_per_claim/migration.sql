-- Chat before the quote (phase 5b): one thread per lawyer on a request, opening when they join.
-- Each message belongs to a lawyer's claim, and each side's "last read" moves from the request to
-- the claim. Today's threads are all with the engaged lawyer, so they move to that claim.

-- AlterTable
ALTER TABLE "ClientRequestClaim" ADD COLUMN     "clientReadAt" TIMESTAMP(3),
ADD COLUMN     "lawyerReadAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "EngagementMessage" ADD COLUMN     "claimId" TEXT;

-- Today's messages and read markers belong to the engaged lawyer's claim.
UPDATE "EngagementMessage" m
SET "claimId" = c."id"
FROM "ClientRequestClaim" c
WHERE c."requestId" = m."requestId" AND c."outcome" = 'ENGAGED';

UPDATE "ClientRequestClaim" c
SET "lawyerReadAt" = r."lawyerReadAt", "clientReadAt" = r."clientReadAt"
FROM "ClientRequest" r
WHERE r."id" = c."requestId" AND c."outcome" = 'ENGAGED';

-- AlterTable
ALTER TABLE "ClientRequest" DROP COLUMN "clientReadAt",
DROP COLUMN "lawyerReadAt";

-- CreateIndex
CREATE INDEX "EngagementMessage_claimId_createdAt_idx" ON "EngagementMessage"("claimId", "createdAt");

-- AddForeignKey
ALTER TABLE "EngagementMessage" ADD CONSTRAINT "EngagementMessage_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ClientRequestClaim"("id") ON DELETE SET NULL ON UPDATE CASCADE;
