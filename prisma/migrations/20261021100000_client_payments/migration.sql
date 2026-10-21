-- Client app payments (dummy provider for now) and chat credits per case.
-- CreateEnum
CREATE TYPE "ClientPaymentKind" AS ENUM ('CASE', 'TOP_UP');

-- CreateEnum
CREATE TYPE "ClientPaymentStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "Case" ADD COLUMN     "clientCredits" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ClientPayment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "caseId" TEXT,
    "kind" "ClientPaymentKind" NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "promoCode" TEXT,
    "status" "ClientPaymentStatus" NOT NULL,
    "failureReason" TEXT,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientPayment_userId_kind_status_idx" ON "ClientPayment"("userId", "kind", "status");

-- CreateIndex
CREATE INDEX "ClientPayment_caseId_idx" ON "ClientPayment"("caseId");

-- AddForeignKey
ALTER TABLE "ClientPayment" ADD CONSTRAINT "ClientPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientPayment" ADD CONSTRAINT "ClientPayment_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Client cases made before payments existed (staging/dev only) get the credits a payment would give.
UPDATE "Case" SET "clientCredits" = 50 WHERE "practiceArea" IS NOT NULL;
