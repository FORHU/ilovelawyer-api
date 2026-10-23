-- Move the AI allowance top-up credit from Case to User (account-level billing, not per-case).
ALTER TABLE "User" ADD COLUMN "extraAiAllowanceUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Case" DROP COLUMN "extraAiAllowanceUsd";

-- Replace CaseAiTopUp (per-case) with AccountAiTopUp (per-account, no case).
DROP TABLE "CaseAiTopUp";
DROP TYPE "CaseAiTopUpStatus";

CREATE TYPE "AccountAiTopUpStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED');

CREATE TABLE "AccountAiTopUp" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "topUpAmountUsd" DOUBLE PRECISION NOT NULL,
    "feeAmountUsd" DOUBLE PRECISION NOT NULL,
    "totalChargedUsd" DOUBLE PRECISION NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT,
    "status" "AccountAiTopUpStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "grantedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountAiTopUp_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AccountAiTopUp_externalId_idx" ON "AccountAiTopUp"("externalId");
CREATE INDEX "AccountAiTopUp_userId_idx" ON "AccountAiTopUp"("userId");

ALTER TABLE "AccountAiTopUp" ADD CONSTRAINT "AccountAiTopUp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
