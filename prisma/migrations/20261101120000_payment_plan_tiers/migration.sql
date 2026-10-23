-- CreateEnum
CREATE TYPE "PaymentPlanType" AS ENUM ('B2B_SUBSCRIPTION', 'B2C_CASE');

-- CreateEnum
CREATE TYPE "PaymentPlanSubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED');

-- AlterTable
ALTER TABLE "User"
ADD COLUMN     "allowancePeriodStart" TIMESTAMP(3),
ADD COLUMN     "caseLimitNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "paymentPlanId" TEXT;

-- CreateTable
CREATE TABLE "PaymentPlan" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planType" "PaymentPlanType" NOT NULL DEFAULT 'B2B_SUBSCRIPTION',
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 0,
    "feeUsd" DOUBLE PRECISION NOT NULL,
    "includedAllowanceUsd" DOUBLE PRECISION NOT NULL,
    "caseLimit" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "stripeProductId" TEXT,
    "stripePriceId" TEXT,
    "stripePriceAmountMinor" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "PaymentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentPlanSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "paymentPlanId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "checkoutSessionId" TEXT,
    "stripeSubscriptionId" TEXT,
    "stripePriceId" TEXT,
    "status" "PaymentPlanSubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "lastPeriodInvoiceId" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentPlanSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentPlan_stripeProductId_key" ON "PaymentPlan"("stripeProductId");

-- CreateIndex
CREATE INDEX "PaymentPlan_tenantId_planType_idx" ON "PaymentPlan"("tenantId", "planType");

-- CreateIndex
CREATE INDEX "PaymentPlan_updatedById_idx" ON "PaymentPlan"("updatedById");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentPlan_tenantId_planType_code_key" ON "PaymentPlan"("tenantId", "planType", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentPlanSubscription_checkoutSessionId_key" ON "PaymentPlanSubscription"("checkoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentPlanSubscription_stripeSubscriptionId_key" ON "PaymentPlanSubscription"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "PaymentPlanSubscription_userId_status_idx" ON "PaymentPlanSubscription"("userId", "status");

-- CreateIndex
CREATE INDEX "User_paymentPlanId_idx" ON "User"("paymentPlanId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_paymentPlanId_fkey" FOREIGN KEY ("paymentPlanId") REFERENCES "PaymentPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPlan" ADD CONSTRAINT "PaymentPlan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPlan" ADD CONSTRAINT "PaymentPlan_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPlanSubscription" ADD CONSTRAINT "PaymentPlanSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPlanSubscription" ADD CONSTRAINT "PaymentPlanSubscription_paymentPlanId_fkey" FOREIGN KEY ("paymentPlanId") REFERENCES "PaymentPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed every existing tenant with the three placeholder B2B tiers (Standard/Pro/Max), using the
-- product-given placeholder numbers. Admin-editable afterwards via PaymentPlanSvc. Same numbers as
-- PAYMENT_PLAN_DEFAULT_TIERS, which the tenant seeder uses for tenants created after this runs.
INSERT INTO "PaymentPlan" ("id", "tenantId", "planType", "code", "name", "level", "feeUsd", "includedAllowanceUsd", "caseLimit", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t."id", 'B2B_SUBSCRIPTION', tier.code, tier.name, tier.level, tier."feeUsd", tier."includedAllowanceUsd", tier."caseLimit", true, NOW(), NOW()
FROM "Tenant" t
CROSS JOIN (
  VALUES
    ('standard', 'Standard', 0, 20.0, 10.0, 5),
    ('pro',      'Pro',      1, 50.0, 30.0, 10),
    ('max',      'Max',      2, 100.0, 80.0, 50)
) AS tier(code, name, level, "feeUsd", "includedAllowanceUsd", "caseLimit");

-- Backfill every existing LAWYER with no tier yet onto their tenant's Standard tier — a valid,
-- never-charged "grandfathered" state (see AccountLimitsSvc / PaymentPlanBillingSvc). This is a
-- deliberate reversal of MAX_CASES_PER_ACCOUNT's off-by-default behavior, so lawyers who already
-- own more cases than Standard's limit are not retroactively blocked: assertCanCreateCase only
-- fires on new case creation, so existing cases stay accessible either way.
--
-- Their allowance period starts now. Spend was summed all-time against the old flat plan's
-- allowance ($20 by default); summing it all-time against Standard's $10 would lock every lawyer
-- who had ever spent $10 the moment this runs.
UPDATE "User" u
SET "paymentPlanId" = pp."id",
    "allowancePeriodStart" = NOW()
FROM "PaymentPlan" pp
WHERE pp."tenantId" = u."tenantId"
  AND pp."planType" = 'B2B_SUBSCRIPTION'
  AND pp."code" = 'standard'
  AND u."role" = 'LAWYER'
  AND u."tenantId" IS NOT NULL
  AND u."paymentPlanId" IS NULL;

