/** The client app's prices for specs that don't need a live Postgres: stands in for one tenant's
 * PaymentPlan B2C rows and ClientPromo rows, as the client_pricing_seed migration creates them.
 * Every client in these specs is in TENANT_ID. installClientPricing() replaces the repository
 * reads and returns a restore function, same stash idiom as the specs. */
import ClientPricingRepo from "../../src/repositories/client-pricing.repository";
import ClientPaymentRepo from "../../src/repositories/client-payment.repository";
import { redis } from "../../src/lib/redis";

export const TENANT_ID = "tenant-uk";
export const CASE_PRICE_MINOR = 999;
export const CASE_CREDITS = 50;

function priceRow(planType: "B2C_CASE" | "B2C_TOP_UP", code: string, name: string, level: number, priceMinor: number, credits: number, extra: object = {}) {
  return { id: `plan-${code}`, tenantId: TENANT_ID, tenant: { code: "UK" }, planType, code, name, level, priceMinor, credits, currency: "USD", isActive: true, isDefault: false, ...extra };
}

export function clientPriceRows() {
  return [
    priceRow("B2C_CASE", "case", "Case", 0, CASE_PRICE_MINOR, CASE_CREDITS),
    priceRow("B2C_TOP_UP", "p25", "Small", 0, 499, 25),
    priceRow("B2C_TOP_UP", "p100", "Standard", 1, 1499, 100, { isDefault: true }),
    priceRow("B2C_TOP_UP", "p250", "Large", 2, 2999, 250),
  ];
}

export function welcomePromo(extra: object = {}) {
  return {
    id: "promo-welcome5",
    tenantId: TENANT_ID,
    tenant: { code: "UK" },
    code: "WELCOME5",
    description: "$5 off your first case",
    discountMinor: 500,
    currency: "USD",
    firstCaseOnly: true,
    oncePerClient: false,
    expiresAt: null,
    maxRedemptions: null,
    isActive: true,
    ...extra,
  };
}

export interface ClientPricingState {
  rows: any[];
  promos: any[];
  /** Redemptions per code, and per `${code}:${userId}`. */
  redemptions: Record<string, number>;
}

export function installClientPricing(state: ClientPricingState): () => void {
  const repo = ClientPricingRepo as any;
  const payments = ClientPaymentRepo as any;
  const cache = redis as any;
  const saved = {
    listPrices: repo.listPrices,
    findPromoByCode: repo.findPromoByCode,
    countPromoRedemptions: payments.countPromoRedemptions,
    findTenantId: payments.findTenantId,
    get: cache.get,
  };
  // A local Redis would otherwise hand one spec the price list another spec cached.
  cache.get = async (key: string) => (key.startsWith("client-pricing:") ? null : saved.get(key));
  repo.listPrices = async (tenantId: string) => state.rows.filter((r) => r.tenantId === tenantId);
  repo.findPromoByCode = async (tenantId: string, code: string) => state.promos.find((p) => p.tenantId === tenantId && p.code === code) ?? null;
  payments.countPromoRedemptions = async (_tenantId: string, code: string, userId?: string) => state.redemptions[userId ? `${code}:${userId}` : code] ?? 0;
  payments.findTenantId = async () => TENANT_ID;
  return () => {
    repo.listPrices = saved.listPrices;
    repo.findPromoByCode = saved.findPromoByCode;
    payments.countPromoRedemptions = saved.countPromoRedemptions;
    payments.findTenantId = saved.findTenantId;
    cache.get = saved.get;
  };
}
