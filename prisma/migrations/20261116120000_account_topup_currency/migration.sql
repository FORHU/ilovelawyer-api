-- A lawyer's account AI top-up is charged in their site's currency (won on KR). The dollar columns
-- keep the AI usage bought and its dollar value; these record what was actually charged.
ALTER TABLE "AccountAiTopUp"
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USD',
ADD COLUMN     "feeAmountMinor" INTEGER,
ADD COLUMN     "topUpAmountMinor" INTEGER,
ADD COLUMN     "totalChargedMinor" INTEGER;

-- Every top-up so far was charged in US dollars.
UPDATE "AccountAiTopUp"
SET "topUpAmountMinor" = ROUND("topUpAmountUsd" * 100),
    "feeAmountMinor" = ROUND("feeAmountUsd" * 100),
    "totalChargedMinor" = ROUND("totalChargedUsd" * 100);
