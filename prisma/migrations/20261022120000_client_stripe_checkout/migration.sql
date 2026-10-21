-- Client payments through Stripe Checkout: a PENDING status while the client pays, and a ledger of
-- handled Stripe webhook events so a retried delivery is never applied twice.
-- AlterEnum
ALTER TYPE "ClientPaymentStatus" ADD VALUE 'PENDING';

-- CreateTable
CREATE TABLE "StripeWebhookEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StripeWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientPayment_externalId_idx" ON "ClientPayment"("externalId");

