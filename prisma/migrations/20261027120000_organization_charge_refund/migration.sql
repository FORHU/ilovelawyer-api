-- Refunds of a law firm's charges, issued by platform admins (ilovelawyer-api#520).
-- CreateEnum
CREATE TYPE "OrganizationChargeRefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');


-- CreateTable
CREATE TABLE "OrganizationChargeRefund" (
    "id" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "OrganizationChargeRefundStatus" NOT NULL,
    "externalId" TEXT,
    "failureReason" TEXT,
    "adminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationChargeRefund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationChargeRefund_chargeId_idx" ON "OrganizationChargeRefund"("chargeId");

-- CreateIndex
CREATE INDEX "OrganizationChargeRefund_externalId_idx" ON "OrganizationChargeRefund"("externalId");

-- AddForeignKey
ALTER TABLE "OrganizationChargeRefund" ADD CONSTRAINT "OrganizationChargeRefund_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "OrganizationCharge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

