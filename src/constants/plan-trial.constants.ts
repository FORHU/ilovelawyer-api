import type { PaymentPlanSubscriptionStatus } from "@prisma/client";

/** How long a solo lawyer's free trial of their tier lasts, from the moment the account is both
 * approved and solo (PlanTrialSvc). The plan_trial migration gives existing solo lawyers the same
 * 14 days from release — keep the two in step. */
export const PLAN_TRIAL_DAYS = 14;

/** How long before the trial ends the "ends soon" email goes out (PlanTrialSweepQueue). */
export const PLAN_TRIAL_REMINDER_DAYS = 3;

/** Still paying (or being retried): a subscription that keeps the account open once its trial is
 * over. Same set as PaymentPlanSubscriptionRepo's, which imports AccountLimitsSvc, so it can't be
 * imported from there. */
export const LIVE_SUBSCRIPTION_STATUSES: PaymentPlanSubscriptionStatus[] = ["ACTIVE", "PAST_DUE"];

/** The lawyer app's page listing every tier, where the trial emails send the lawyer. */
export const PLANS_PAGE_PATH = "/plans";

export const DAY_MS = 24 * 60 * 60 * 1000;
