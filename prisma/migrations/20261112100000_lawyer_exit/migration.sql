-- Lawyer Exit (FORHU/ilovelawyer-app#972): a lawyer ending a paid engagement because they can't
-- continue, and the refund that follows. See LawyerExit in schema.prisma.

-- An earning's hold now starts when the engagement closes: null while it's open, or while a Lawyer
-- Exit on it is unsettled. Earnings made before keep the date they were given at payment.
ALTER TABLE "Earning" ALTER COLUMN "availableAt" DROP NOT NULL;

-- CreateEnum
CREATE TYPE "LawyerExitStatus" AS ENUM ('REFUNDING', 'AWAITING_REVIEW', 'WAITING_ON_DISPUTE', 'NEEDS_ATTENTION', 'SETTLED');

-- CreateTable
CREATE TABLE "LawyerExit" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "lawyerId" TEXT NOT NULL,
    "organizationId" TEXT,
    "paymentId" TEXT,
    "reason" "ReleaseReason" NOT NULL,
    "note" TEXT,
    "workDone" BOOLEAN NOT NULL,
    "claimedMinor" INTEGER,
    "claimNote" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "status" "LawyerExitStatus" NOT NULL,
    "refundedMinor" INTEGER NOT NULL DEFAULT 0,
    "refundId" TEXT,
    "failureReason" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LawyerExit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LawyerExit_requestId_key" ON "LawyerExit"("requestId");

-- CreateIndex
CREATE INDEX "LawyerExit_caseId_idx" ON "LawyerExit"("caseId");

-- CreateIndex
CREATE INDEX "LawyerExit_paymentId_idx" ON "LawyerExit"("paymentId");

-- CreateIndex
CREATE INDEX "LawyerExit_status_createdAt_idx" ON "LawyerExit"("status", "createdAt");
