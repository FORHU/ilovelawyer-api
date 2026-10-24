-- A solo lawyer's 14-day free trial of their tier (PlanTrialSvc): once it ends with no live
-- subscription, the account is read-only until they subscribe (AccountLimitsSvc).

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "planTrialEndedNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "planTrialEndsAt" TIMESTAMP(3),
ADD COLUMN     "planTrialReminderSentAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "User_planTrialEndsAt_idx" ON "User"("planTrialEndsAt");

-- Every solo lawyer already approved and not paying gets the same 14 days (PLAN_TRIAL_DAYS) from
-- now, so nobody is locked out the moment this ships. Trial guests (trialExpiresAt) and firm
-- lawyers (no soloChosenAt) get none.
UPDATE "User" u
SET "planTrialEndsAt" = NOW() + INTERVAL '14 days'
WHERE u."role" = 'LAWYER'
  AND u."tenantId" IS NOT NULL
  AND u."approvalStatus" = 'ACTIVE'
  AND u."soloChosenAt" IS NOT NULL
  AND u."trialExpiresAt" IS NULL
  AND u."planTrialEndsAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "PaymentPlanSubscription" s
    WHERE s."userId" = u."id" AND s."status" IN ('ACTIVE', 'PAST_DUE')
  );
