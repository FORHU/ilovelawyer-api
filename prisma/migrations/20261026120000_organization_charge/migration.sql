-- Charges to a law firm's card on file: the per-case fee when a client confirms (ilovelawyer-api#513).
-- CreateEnum
CREATE TYPE "OrganizationChargeKind" AS ENUM ('PER_CASE_FEE', 'AI_TOP_UP');

-- CreateEnum
CREATE TYPE "OrganizationChargeStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- AlterTable
ALTER TABLE "ClientRequest" ADD COLUMN     "engagedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ClientRequestClaim" ADD COLUMN     "declineReason" TEXT;


-- CreateTable
CREATE TABLE "OrganizationCharge" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "OrganizationChargeKind" NOT NULL,
    "status" "OrganizationChargeStatus" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "provider" TEXT,
    "requestId" TEXT,
    "feeRequestId" TEXT,
    "lawyerId" TEXT,
    "paymentIntentId" TEXT,
    "receiptUrl" TEXT,
    "failureReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "succeededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationCharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationCharge_feeRequestId_key" ON "OrganizationCharge"("feeRequestId");

-- CreateIndex
CREATE INDEX "OrganizationCharge_organizationId_createdAt_idx" ON "OrganizationCharge"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "OrganizationCharge_requestId_idx" ON "OrganizationCharge"("requestId");

-- CreateIndex
CREATE INDEX "OrganizationCharge_paymentIntentId_idx" ON "OrganizationCharge"("paymentIntentId");

-- AddForeignKey
ALTER TABLE "OrganizationCharge" ADD CONSTRAINT "OrganizationCharge_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationCharge" ADD CONSTRAINT "OrganizationCharge_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ClientRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

