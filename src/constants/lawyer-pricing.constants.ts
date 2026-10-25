/**
 * What lawyers pay in the UK client-to-lawyer hand-off, edited by admins (ilovelawyer-admin Settings)
 * per tenant like the client app's prices (LawyerPricingSvc, #598): the introduction fee charged
 * when a client confirms a lawyer, and the AI top-up packs an engaged lawyer can buy (#516). Stored
 * as PaymentPlan rows (LAWYER_INTRO_FEE, LAWYER_AI_TOP_UP), in GBP like every quote.
 *
 * What every tenant starts with: the lawyer_pricing_seed migration seeded these into the tenants
 * that existed then, and the tenant seeder adds them to any tenant created later. Keep the two in
 * step. Also what LawyerPricingSvc falls back to if a tenant's fee row is ever missing. Prices are
 * placeholders until FORHU/ilovelawyer-app#846 signs them off.
 */
export const LAWYER_PRICING_DEFAULTS = {
  currency: "GBP",
  introFee: { code: "intro", name: "Introduction fee", priceMinor: 5000 },
  packs: [{ code: "standard", name: "Standard", level: 0, priceMinor: 4000, creditMinor: 2400 }],
} as const;

/** A lawyer price in pence: at least Stripe's GBP minimum, and at most £1,000, to catch a typo
 * like an extra zero. */
export const LAWYER_PRICE_MIN_MINOR = 30;
export const LAWYER_PRICE_MAX_MINOR = 100_000;

export const lawyerPricingCacheKey = (tenantId: string) => `lawyer-pricing:v1:${tenantId}`;
/** How long a price edit can take to reach the next confirmation or top-up. */
export const LAWYER_PRICING_CACHE_TTL_S = 60;
