-- Refunds on client app payments, issued by platform admins (ilovelawyer-api#538).
-- CreateEnum
CREATE TYPE "ClientRefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "ClientRefund" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ClientRefundStatus" NOT NULL,
    "externalId" TEXT,
    "failureReason" TEXT,
    "adminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientRefund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientRefund_paymentId_idx" ON "ClientRefund"("paymentId");

-- CreateIndex
CREATE INDEX "ClientRefund_externalId_idx" ON "ClientRefund"("externalId");

-- CreateIndex
CREATE INDEX "ClientPayment_createdAt_idx" ON "ClientPayment"("createdAt");

-- AddForeignKey
ALTER TABLE "ClientRefund" ADD CONSTRAINT "ClientRefund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "ClientPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
