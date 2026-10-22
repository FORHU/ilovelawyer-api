-- A lawyer's conflict-check release and quote on a client request claim (ilovelawyer-api#512).
-- CreateEnum
CREATE TYPE "QuoteType" AS ENUM ('FIXED_FEE', 'FIRST_CONSULTATION');

-- CreateEnum
CREATE TYPE "ReleaseReason" AS ENUM ('CONFLICT', 'CAPACITY', 'OUT_OF_SCOPE', 'OTHER');

-- AlterTable
ALTER TABLE "ClientRequestClaim" ADD COLUMN     "quoteAmountMinor" INTEGER,
ADD COLUMN     "quoteCurrency" TEXT,
ADD COLUMN     "quoteMessage" TEXT,
ADD COLUMN     "quoteType" "QuoteType",
ADD COLUMN     "quotedAt" TIMESTAMP(3),
ADD COLUMN     "releaseNote" TEXT,
ADD COLUMN     "releaseReason" "ReleaseReason";
