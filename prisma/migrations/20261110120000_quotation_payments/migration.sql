-- Quotation payments: the client pays the lawyer's quote plus a platform fee through ilovelawyer's
-- Stripe account; the lawyer's service fee goes to a wallet (PENDING, then AVAILABLE) and is paid
-- out through Stripe Connect. Replaces the per-case fee for every request accepted from now on.

-- CreateEnum
CREATE TYPE "QuotationStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'PAID', 'REJECTED', 'WITHDRAWN', 'EXPIRED', 'NOT_CHOSEN');

-- CreateEnum
CREATE TYPE "QuotationPaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "QuotationRefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "WalletOwnerType" AS ENUM ('ORGANIZATION', 'USER');

-- CreateEnum
CREATE TYPE "EarningStatus" AS ENUM ('PENDING', 'AVAILABLE', 'REVERSED');

-- CreateEnum
CREATE TYPE "WalletBucket" AS ENUM ('PENDING', 'AVAILABLE', 'RESERVED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "WalletEntryKind" AS ENUM ('EARNING', 'RELEASE', 'WITHDRAWAL', 'REVERSAL', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('REQUESTED', 'PROCESSING', 'PAID', 'FAILED', 'REJECTED');

-- CreateTable
CREATE TABLE "Quotation" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "lawyerId" TEXT NOT NULL,
    "type" "QuoteType" NOT NULL,
    "serviceFeeMinor" INTEGER NOT NULL,
    "platformFeeBps" INTEGER NOT NULL,
    "platformFeeMinor" INTEGER NOT NULL,
    "totalAmountMinor" INTEGER NOT NULL,
    "acceptedAmountMinor" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "message" TEXT NOT NULL DEFAULT '',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "QuotationStatus" NOT NULL DEFAULT 'DRAFT',
    "sentAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuotationPayment" (
    "id" TEXT NOT NULL,
    "quotationId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "serviceFeeMinor" INTEGER NOT NULL,
    "platformFeeMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "paymentIntentId" TEXT,
    "status" "QuotationPaymentStatus" NOT NULL,
    "failureReason" TEXT,
    "refundedMinor" INTEGER NOT NULL DEFAULT 0,
    "succeededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuotationPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuotationRefund" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "serviceFeeMinor" INTEGER NOT NULL,
    "platformFeeMinor" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "QuotationRefundStatus" NOT NULL,
    "externalId" TEXT,
    "failureReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuotationRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "ownerType" "WalletOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "provider" TEXT,
    "stripeAccountId" TEXT,
    "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "detailsSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Earning" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "quotationId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "lawyerId" TEXT NOT NULL,
    "grossMinor" INTEGER NOT NULL,
    "platformFeeMinor" INTEGER NOT NULL,
    "netMinor" INTEGER NOT NULL,
    "reversedMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "status" "EarningStatus" NOT NULL DEFAULT 'PENDING',
    "disputed" BOOLEAN NOT NULL DEFAULT false,
    "availableAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Earning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletLedgerEntry" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "bucket" "WalletBucket" NOT NULL,
    "kind" "WalletEntryKind" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "sourceId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Withdrawal" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "WithdrawalStatus" NOT NULL,
    "provider" TEXT,
    "transferId" TEXT,
    "payoutId" TEXT,
    "failureReason" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Withdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutSettings" (
    "tenantId" TEXT NOT NULL,
    "platformFeeBps" INTEGER NOT NULL,
    "minPlatformFeeMinor" INTEGER NOT NULL,
    "earningsHoldDays" INTEGER NOT NULL,
    "minWithdrawalMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutSettings_pkey" PRIMARY KEY ("tenantId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Quotation_claimId_key" ON "Quotation"("claimId");

-- CreateIndex
CREATE INDEX "Quotation_requestId_idx" ON "Quotation"("requestId");

-- CreateIndex
CREATE INDEX "Quotation_status_expiresAt_idx" ON "Quotation"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "QuotationPayment_paymentIntentId_key" ON "QuotationPayment"("paymentIntentId");

-- CreateIndex
CREATE INDEX "QuotationPayment_quotationId_status_idx" ON "QuotationPayment"("quotationId", "status");

-- CreateIndex
CREATE INDEX "QuotationPayment_requestId_idx" ON "QuotationPayment"("requestId");

-- CreateIndex
CREATE INDEX "QuotationPayment_createdAt_idx" ON "QuotationPayment"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "QuotationPayment_quotationId_attempt_key" ON "QuotationPayment"("quotationId", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "QuotationRefund_externalId_key" ON "QuotationRefund"("externalId");

-- CreateIndex
CREATE INDEX "QuotationRefund_paymentId_idx" ON "QuotationRefund"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_stripeAccountId_key" ON "Wallet"("stripeAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_ownerType_ownerId_key" ON "Wallet"("ownerType", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "Earning_paymentId_key" ON "Earning"("paymentId");

-- CreateIndex
CREATE INDEX "Earning_walletId_createdAt_idx" ON "Earning"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "Earning_status_availableAt_idx" ON "Earning"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "WalletLedgerEntry_idempotencyKey_key" ON "WalletLedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "WalletLedgerEntry_walletId_bucket_idx" ON "WalletLedgerEntry"("walletId", "bucket");

-- CreateIndex
CREATE INDEX "WalletLedgerEntry_walletId_createdAt_idx" ON "WalletLedgerEntry"("walletId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Withdrawal_idempotencyKey_key" ON "Withdrawal"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Withdrawal_transferId_key" ON "Withdrawal"("transferId");

-- CreateIndex
CREATE UNIQUE INDEX "Withdrawal_payoutId_key" ON "Withdrawal"("payoutId");

-- CreateIndex
CREATE INDEX "Withdrawal_walletId_createdAt_idx" ON "Withdrawal"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "Withdrawal_status_idx" ON "Withdrawal"("status");

-- AddForeignKey
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ClientRequestClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ClientRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuotationRefund" ADD CONSTRAINT "QuotationRefund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "QuotationPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Earning" ADD CONSTRAINT "Earning_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutSettings" ADD CONSTRAINT "PayoutSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: a Quotation for every quote already sent, from the claim's quote columns. These were
-- made before the platform fee existed, so they carry none (the client pays the quoted amount and
-- the lawyer receives all of it). A quote still waiting on the client expires when its request's
-- pick-by date does. Requests already CONFIRMED or ENGAGED keep their per-case fee: their quotation
-- is ACCEPTED, with nothing for the client to pay through ilovelawyer.
INSERT INTO "Quotation" (
  "id", "claimId", "requestId", "lawyerId", "type", "serviceFeeMinor", "platformFeeBps", "platformFeeMinor",
  "totalAmountMinor", "acceptedAmountMinor", "currency", "message", "expiresAt", "status", "sentAt",
  "acceptedAt", "rejectedAt", "rejectReason", "closedAt", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  c."id",
  c."requestId",
  c."lawyerId",
  c."quoteType",
  COALESCE(c."quoteAmountMinor", 0),
  0,
  0,
  COALESCE(c."quoteAmountMinor", 0),
  CASE WHEN c."outcome" = 'ENGAGED' OR (c."outcome" IS NULL AND r."status" = 'CONFIRMED') THEN COALESCE(c."quoteAmountMinor", 0) END,
  COALESCE(c."quoteCurrency", 'GBP'),
  COALESCE(c."quoteMessage", ''),
  COALESCE(r."pickByAt", c."quotedAt" + INTERVAL '7 days'),
  (CASE
    WHEN c."outcome" = 'ENGAGED' OR (c."outcome" IS NULL AND r."status" = 'CONFIRMED') THEN 'ACCEPTED'
    WHEN c."outcome" IS NULL THEN 'SENT'
    WHEN c."outcome" = 'DECLINED' THEN 'REJECTED'
    WHEN c."outcome" = 'NOT_CHOSEN' THEN 'NOT_CHOSEN'
    ELSE 'WITHDRAWN'
  END)::"QuotationStatus",
  c."quotedAt",
  CASE WHEN c."outcome" = 'ENGAGED' OR (c."outcome" IS NULL AND r."status" = 'CONFIRMED') THEN COALESCE(r."engagedAt", c."quotedAt") END,
  CASE WHEN c."outcome" = 'DECLINED' THEN c."endedAt" END,
  CASE WHEN c."outcome" = 'DECLINED' THEN c."declineReason" END,
  CASE WHEN c."outcome" IS NOT NULL AND c."outcome" <> 'ENGAGED' THEN c."endedAt" END,
  c."quotedAt",
  NOW()
FROM "ClientRequestClaim" c
JOIN "ClientRequest" r ON r."id" = c."requestId"
WHERE c."quotedAt" IS NOT NULL AND c."quoteType" IS NOT NULL;
