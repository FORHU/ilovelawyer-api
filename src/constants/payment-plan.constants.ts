import type { PaymentPlan } from "@prisma/client";
import type { TenantCode } from "../types/tenant-code";

/**
 * The currencies a lawyer's monthly plan (a B2B_SUBSCRIPTION PaymentPlan) is charged in. A tier's
 * price is `priceMinor` in its `currency`, in that currency's smallest unit: cents for USD ($20 is
 * 2000), whole won for KRW (₩29,000 is 29000, since KRW has no smaller unit; Stripe treats it as a
 * zero-decimal currency, so the same number is Stripe's unit_amount).
 *
 * `exponent` is the currency's minor-unit digits. `maxMinor` is our own ceiling, to catch a typo
 * like an extra zero ($10,000 / ₩10,000,000 a month).
 */
export const PLAN_CURRENCIES = {
  USD: { exponent: 2, maxMinor: 1_000_000 },
  KRW: { exponent: 0, maxMinor: 10_000_000 },
} as const;

export type PlanCurrency = keyof typeof PLAN_CURRENCIES;

/** Each site's plan currency. It's set by the site, never by the admin, who edits only the amount.
 * Changing a site's currency needs a migration that reprices its tiers (see
 * 20261116110000_payment_plan_currency). */
export const PLAN_CURRENCY_BY_TENANT = { PH: "USD", UK: "USD", KR: "KRW" } as const satisfies Record<TenantCode, PlanCurrency>;

export function planCurrencyOf(tenantCode: TenantCode): PlanCurrency {
  return PLAN_CURRENCY_BY_TENANT[tenantCode];
}

/** A minor-unit amount in major units: 2000 USD is 20, 29000 KRW is 29000. */
export function toMajor(amountMinor: number, currency: string): number {
  const exponent = PLAN_CURRENCIES[currency.toUpperCase() as PlanCurrency]?.exponent ?? 2;
  return amountMinor / 10 ** exponent;
}

/** What a tier costs a month. Every B2B tier has priceMinor and currency (the
 * payment_plan_currency migration filled them, and PaymentPlanSvc writes them); the feeUsd
 * fallback only covers a row written without them, which is then a USD tier. */
export function planPrice(plan: Pick<PaymentPlan, "priceMinor" | "currency" | "feeUsd">): { amountMinor: number; currency: PlanCurrency } {
  if (plan.priceMinor !== null && plan.currency) return { amountMinor: plan.priceMinor, currency: plan.currency as PlanCurrency };
  return { amountMinor: Math.round(plan.feeUsd * 100), currency: "USD" };
}

/** feeUsd is still a required column. It's kept equal to the price for a USD tier, so nothing
 * that still reads it is wrong, and 0 for a tier in any other currency, which has no US dollar
 * fee. Nothing reads it for a B2B tier any more. */
export function legacyFeeUsd(amountMinor: number, currency: PlanCurrency): number {
  return currency === "USD" ? amountMinor / 100 : 0;
}

/** The placeholder B2B tiers every Tenant starts with (PaymentPlanSvc), priced in each currency. The
 * payment_plan_tiers migration seeded these into the tenants that existed then (and
 * payment_plan_currency priced KR's in won); the tenant seeder adds them to any tenant created later.
 * Keep them in step. The KR prices are placeholders until real ones are set in the admin. */
interface DefaultTier {
  code: string;
  name: string;
  level: number;
  priceMinor: Record<PlanCurrency, number>;
  includedAllowanceUsd: number;
  caseLimit: number;
  clientRequestLimit: number;
}

export const PAYMENT_PLAN_DEFAULT_TIERS = [
  { code: "standard", name: "Standard", level: 0, priceMinor: { USD: 2_000, KRW: 29_000 }, includedAllowanceUsd: 10, caseLimit: 5, clientRequestLimit: 3 },
  { code: "pro", name: "Pro", level: 1, priceMinor: { USD: 5_000, KRW: 69_000 }, includedAllowanceUsd: 30, caseLimit: 10, clientRequestLimit: 10 },
  { code: "max", name: "Max", level: 2, priceMinor: { USD: 10_000, KRW: 139_000 }, includedAllowanceUsd: 80, caseLimit: 50, clientRequestLimit: 0 },
] as const satisfies readonly DefaultTier[];
