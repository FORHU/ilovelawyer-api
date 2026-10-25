-- How many client requests a lawyer on a tier can take on per calendar month (AccountLimitsSvc
-- .assertCanTakeClientRequest). 0 = unlimited.

-- AlterTable
ALTER TABLE "PaymentPlan" ADD COLUMN     "clientRequestLimit" INTEGER NOT NULL DEFAULT 0;

-- The default tiers' starting numbers (PAYMENT_PLAN_DEFAULT_TIERS): Standard 3 a month, Pro 10, Max
-- unlimited. By code alone: the column is new, so no admin has chosen a value for it yet (and an
-- edited-since check would miss every tier the Stripe price sync has touched). Admin-editable after.
UPDATE "PaymentPlan" SET "clientRequestLimit" = 3 WHERE "planType" = 'B2B_SUBSCRIPTION' AND "code" = 'standard';
UPDATE "PaymentPlan" SET "clientRequestLimit" = 10 WHERE "planType" = 'B2B_SUBSCRIPTION' AND "code" = 'pro';
