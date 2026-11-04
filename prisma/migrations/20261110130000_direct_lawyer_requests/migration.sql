-- A client asking for one lawyer by name from the marketplace: only that lawyer is offered the
-- request for 24h, then it goes to every matching lawyer.

-- AlterTable
ALTER TABLE "ClientRequest" ADD COLUMN "requestedLawyerId" TEXT,
ADD COLUMN "requestedOnly" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "ClientRequest_requestedLawyerId_idx" ON "ClientRequest"("requestedLawyerId");

-- AddForeignKey
ALTER TABLE "ClientRequest" ADD CONSTRAINT "ClientRequest_requestedLawyerId_fkey" FOREIGN KEY ("requestedLawyerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
