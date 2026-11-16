import type { PlanCurrency } from "./payment-plan.constants";

/**
 * A lawyer's self-serve account AI top-up (AccountTopUpPricingSvc) is charged in their site's
 * currency, the same one their plan is in (PaymentPlanSvc.siteCurrency): won on KR, for example. The AI usage it buys is still counted in US dollars (extraAiAllowanceUsd), because that's what
 * AI costs. On a site that charges in another currency, an admin-set rate turns the amount paid into
 * dollars of AI usage (TENANT_SETTING_KEYS.accountTopUpRate).
 *
 * Amounts are in the currency's smallest unit (cents; whole won). `presetsMinor` are the amounts the
 * lawyer app offers as buttons. `defaultFee` is the platform fee until an admin saves one: FIXED is
 * an amount in the site's currency (major units), PERCENT is 0-100.
 */
export const ACCOUNT_TOPUP_TERMS = {
  USD: { minMinor: 500, maxMinor: 50_000, presetsMinor: [1_000, 2_000, 5_000], defaultFee: { feeType: "FIXED", feeAmount: 0.8 } },
  GBP: { minMinor: 500, maxMinor: 40_000, presetsMinor: [1_000, 2_000, 5_000], defaultFee: { feeType: "FIXED", feeAmount: 0.6 } },
  PHP: { minMinor: 30_000, maxMinor: 3_000_000, presetsMinor: [50_000, 100_000, 300_000], defaultFee: { feeType: "FIXED", feeAmount: 50 } },
  KRW: { minMinor: 5_000, maxMinor: 700_000, presetsMinor: [10_000, 30_000, 70_000], defaultFee: { feeType: "FIXED", feeAmount: 1_000 } },
} as const satisfies Record<PlanCurrency, { minMinor: number; maxMinor: number; presetsMinor: readonly number[]; defaultFee: { feeType: "FIXED" | "PERCENT"; feeAmount: number } }>;

/** How much of the site's currency buys $1 of AI usage, until an admin sets it: ₩1,400 on KR. A USD
 * site is always 1. */
export const AI_CREDIT_RATE_DEFAULT: Record<PlanCurrency, number> = { USD: 1, GBP: 0.8, PHP: 58, KRW: 1_400 };

/** What an admin may set the rate to, to catch a typo like an extra zero. */
export const AI_CREDIT_RATE_LIMITS: Record<Exclude<PlanCurrency, "USD">, { min: number; max: number }> = {
  GBP: { min: 0.3, max: 3 },
  PHP: { min: 10, max: 500 },
  KRW: { min: 100, max: 10_000 },
};
