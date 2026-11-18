-- Lawyer plans (B2B_SUBSCRIPTION tiers) are priced in their site's currency: `priceMinor` in
-- `currency`, the columns the client-app rows already use. PH and UK stay in USD; KR is in won
-- (PLAN_CURRENCY_BY_TENANT in src/constants/payment-plan.constants.ts). Data only: no columns change.

-- PH and UK: the same price, in cents.
UPDATE "PaymentPlan" p
SET "priceMinor" = ROUND(p."feeUsd" * 100), "currency" = 'USD'
FROM "Tenant" t
WHERE p."tenantId" = t."id"
  AND p."planType" = 'B2B_SUBSCRIPTION'
  AND t."code" <> 'KR'
  AND p."priceMinor" IS NULL;

-- KR: in won. The default tiers get the KR placeholder prices (PAYMENT_PLAN_DEFAULT_TIERS); any
-- other KR tier is converted at about 1,400 won to the dollar, rounded to 100 won, for an admin to
-- review. feeUsd goes to 0 (a won tier has no dollar fee). Clearing stripePriceAmountMinor makes the
-- next checkout mint a KRW Stripe Price and archive the old USD one (PaymentPlanStripeSyncSvc).
UPDATE "PaymentPlan" p
SET "priceMinor" = CASE p."code"
      WHEN 'standard' THEN 29000
      WHEN 'pro' THEN 69000
      WHEN 'max' THEN 139000
      ELSE ROUND(p."feeUsd" * 1400 / 100) * 100
    END,
    "currency" = 'KRW',
    "feeUsd" = 0,
    "stripePriceAmountMinor" = NULL
FROM "Tenant" t
WHERE p."tenantId" = t."id"
  AND p."planType" = 'B2B_SUBSCRIPTION'
  AND t."code" = 'KR'
  AND p."currency" IS DISTINCT FROM 'KRW';
