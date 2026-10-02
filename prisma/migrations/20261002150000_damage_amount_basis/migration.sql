-- Where an entry's amount came from: a document states it, it is worked out from a stated rate and
-- period, or it is an AI estimate for the lawyer to review. Null for amounts a lawyer typed.
-- amountNote is the working: the calculation, or the reasoning behind an estimate.

-- CreateEnum
CREATE TYPE "DamageAmountBasis" AS ENUM ('STATED', 'CALCULATED', 'ESTIMATE');

-- AlterTable
ALTER TABLE "DamageClaim" ADD COLUMN "amountBasis" "DamageAmountBasis",
ADD COLUMN "amountNote" TEXT;

-- Existing AI entries with an amount took it from a quote.
UPDATE "DamageClaim" SET "amountBasis" = 'STATED' WHERE "source" = 'AI' AND "amount" IS NOT NULL;
