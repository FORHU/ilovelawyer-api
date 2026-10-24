/**
 * The currencies an admin can price the client app in (ClientPricingSvc). The prices themselves are
 * admin-edited, per-tenant PaymentPlan rows (B2C_CASE, B2C_TOP_UP) and ClientPromo rows; see
 * docs/adr/0017-client-pricing-in-payment-plan.md.
 *
 * `exponent` is the currency's minor-unit digits (2 for cents, 0 for yen). `minMinor` is Stripe's
 * minimum charge in that currency (a price may also be 0, which settles without Stripe).
 * `maxMinor` is our own ceiling, to catch a typo like an extra zero.
 */
export const CLIENT_CURRENCIES = {
  USD: { exponent: 2, minMinor: 50, maxMinor: 99_999 },
  EUR: { exponent: 2, minMinor: 50, maxMinor: 99_999 },
  GBP: { exponent: 2, minMinor: 30, maxMinor: 99_999 },
  CAD: { exponent: 2, minMinor: 50, maxMinor: 99_999 },
  AUD: { exponent: 2, minMinor: 50, maxMinor: 99_999 },
  JPY: { exponent: 0, minMinor: 50, maxMinor: 150_000 },
  PHP: { exponent: 2, minMinor: 2_000, maxMinor: 5_000_000 },
} as const;

export type ClientCurrency = keyof typeof CLIENT_CURRENCIES;

export const CLIENT_CURRENCY_CODES = Object.keys(CLIENT_CURRENCIES) as ClientCurrency[];

export const clientPricingCacheKey = (tenantId: string) => `client-pricing:v2:${tenantId}`;
/** How long a price edit can take to reach checkout. The client app caches for as long again. */
export const CLIENT_PRICING_CACHE_TTL_S = 60;

/** What every tenant starts with: the client_pricing_seed migration seeded these into the tenants
 * that existed then, and the tenant seeder adds them to any tenant created later. Keep the two in
 * step. */
export const CLIENT_PRICING_DEFAULTS = {
  currency: "USD",
  case: { code: "case", name: "Case", level: 0, priceMinor: 999, credits: 50 },
  packs: [
    { code: "p25", name: "Small", level: 0, priceMinor: 499, credits: 25, isDefault: false },
    { code: "p100", name: "Standard", level: 1, priceMinor: 1499, credits: 100, isDefault: true },
    { code: "p250", name: "Large", level: 2, priceMinor: 2999, credits: 250, isDefault: false },
  ],
  promos: [{ code: "WELCOME5", description: "$5 off your first case", discountMinor: 500, firstCaseOnly: true, oncePerClient: false }],
} as const;
