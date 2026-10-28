/** Admins editing a tenant's client app prices and promo codes (ClientPricingSvc): price bounds per
 * currency, the default pack, promo rules, and the security audit row each edit writes. No live
 * Postgres: the repository is monkeypatched, same idiom as test/client-billing.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ClientPricingSvc from "../src/services/client-pricing.service";
import ClientPricingRepo from "../src/repositories/client-pricing.repository";
import SecurityAuditSvc from "../src/services/security-audit.service";
import TenantRepo from "../src/repositories/tenant.repository";
import { TENANT_ID, clientPriceRows, installClientPricing, welcomePromo, type ClientPricingState } from "./support/client-pricing-fixture";

function stash<T extends object>(target: T, keys: string[]) {
  const saved = keys.map((k) => [k, (target as any)[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

async function errorOf(promise: Promise<unknown>): Promise<{ status?: number; code?: string } | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err: any) {
    return { status: err.statusCode, code: err.code };
  }
}

describe("Client app pricing, edited by admins", () => {
  let state: ClientPricingState;
  let restore: () => void;
  let audits: any[];
  let writes: any[];

  beforeEach(() => {
    state = { rows: clientPriceRows(), promos: [welcomePromo()], redemptions: {} };
    const restorePricing = installClientPricing(state);
    const restoreRepo = stash(ClientPricingRepo, ["findPrice", "updatePrice", "createPack", "maxPackLevel", "setDefaultPack", "findPromo", "createPromo", "updatePromo"]);
    const restoreAudit = stash(SecurityAuditSvc, ["record"]);
    const restoreTenants = stash(TenantRepo, ["findByCode"]);
    restore = () => [restorePricing, restoreRepo, restoreAudit, restoreTenants].forEach((f) => f());
    (TenantRepo as any).findByCode = async (code: string) => (code === "UK" ? { id: TENANT_ID, code: "UK" } : null);
    audits = [];
    writes = [];
    const repo = ClientPricingRepo as any;
    repo.findPrice = async (id: string) => state.rows.find((r) => r.id === id) ?? null;
    repo.updatePrice = async (id: string, patch: object) => {
      writes.push({ id, ...patch });
      return { ...state.rows.find((r) => r.id === id), ...patch };
    };
    repo.createPack = async (_tenantId: string, data: object) => {
      writes.push(data);
      return { id: "plan-new", ...data };
    };
    repo.maxPackLevel = async () => 2;
    repo.setDefaultPack = async (_tenantId: string, id: string) => writes.push({ id, isDefault: true });
    repo.findPromo = async (id: string) => state.promos.find((p) => p.id === id) ?? null;
    repo.createPromo = async (tenantId: string, code: string, data: object) => ({ id: "promo-new", tenantId, code, ...data });
    repo.updatePromo = async (id: string, patch: object) => ({ ...state.promos.find((p) => p.id === id), ...patch });
    (SecurityAuditSvc as any).record = async (row: object) => audits.push(row);
  });
  afterEach(() => restore());

  describe("new-case credits", () => {
    it("saves the credits a new case starts with and records who changed them from what", async () => {
      await ClientPricingSvc.updateCase("UK", { credits: 60 }, "admin-1");
      expect(writes[0]).to.deep.include({ id: "plan-case", credits: 60 });
      // Cases are free: the edit never touches a price.
      expect(writes[0]).to.not.have.any.keys("priceMinor", "currency");
      expect(audits[0]).to.deep.include({ action: "admin.settings.client_price_changed", actorId: "admin-1", targetType: "client_price", targetId: "UK:case" });
      expect(audits[0].payload).to.deep.equal({ from: { credits: 50 }, to: { credits: 60 } });
    });

    it("refuses fewer than one credit", async () => {
      expect(await errorOf(ClientPricingSvc.updateCase("UK", { credits: 0 }, "admin-1"))).to.deep.include({ status: 400 });
    });

    it("tells clients the credits, and no case price", async () => {
      expect((await ClientPricingSvc.priceList(TENANT_ID)).case).to.deep.equal({ credits: 50 });
    });
  });

  it("refuses a tenant that doesn't exist", async () => {
    expect(await errorOf(ClientPricingSvc.updateCase("PH", { credits: 60 }, "admin-1"))).to.deep.include({ status: 404 });
  });

  describe("top-up packs", () => {
    it("adds a pack after the others", async () => {
      await ClientPricingSvc.createPack("UK", { code: "P500", name: "Huge", priceMinor: 4999, credits: 500, currency: "usd" }, "admin-1");
      expect(writes[0]).to.include({ code: "p500", level: 3, currency: "USD" });
      expect(audits[0]).to.include({ action: "admin.settings.client_price_created", targetId: "UK:p500" });
    });

    it("won't turn off the default pack, or make an inactive pack the default", async () => {
      expect(await errorOf(ClientPricingSvc.updatePack("plan-p100", { isActive: false }, "admin-1"))).to.deep.equal({ status: 409, code: "DEFAULT_PACK_REQUIRED" });
      state.rows = state.rows.map((r) => (r.code === "p25" ? { ...r, isActive: false } : r));
      expect(await errorOf(ClientPricingSvc.setDefaultPack("plan-p25", "admin-1"))).to.deep.include({ status: 409 });
    });

    it("doesn't treat the case row as a pack", async () => {
      expect(await errorOf(ClientPricingSvc.updatePack("plan-case", { name: "x" }, "admin-1"))).to.deep.include({ status: 404 });
    });

    it("lists only active packs to clients, with the default first chosen", async () => {
      state.rows = state.rows.map((r) => (r.code === "p250" ? { ...r, isActive: false } : r));
      const list = await ClientPricingSvc.priceList(TENANT_ID);
      expect(list.topUpPacks.map((p) => p.id)).to.deep.equal(["p25", "p100"]);
      expect(list.defaultPackId).to.equal("p100");
    });
  });

  describe("promo codes", () => {
    it("stores the code uppercase with its rules", async () => {
      const promo = await ClientPricingSvc.createPromo(
        "UK",
        { code: "spring10", description: "$10 off", discountMinor: 1000, currency: "USD", firstTopUpOnly: false, oncePerClient: true, maxRedemptions: 100 },
        "admin-1",
      );
      expect(promo).to.include({ code: "SPRING10", oncePerClient: true, maxRedemptions: 100, isActive: true });
      expect(audits[0]).to.include({ action: "admin.settings.client_promo_created", targetId: "UK:SPRING10" });
    });

    it("refuses a zero discount or a zero redemption limit", async () => {
      const base = { code: "BAD", description: "x", currency: "USD", firstTopUpOnly: false, oncePerClient: false, maxRedemptions: null };
      expect(await errorOf(ClientPricingSvc.createPromo("UK", { ...base, discountMinor: 0 }, "admin-1"))).to.deep.include({ status: 400 });
      expect(await errorOf(ClientPricingSvc.createPromo("UK", { ...base, discountMinor: 100, maxRedemptions: 0 }, "admin-1"))).to.deep.include({ status: 400 });
    });

    it("turns a code off and records the change", async () => {
      const promo = await ClientPricingSvc.updatePromo("promo-welcome5", { isActive: false }, "admin-1");
      expect(promo.isActive).to.equal(false);
      expect(audits[0]).to.deep.include({ action: "admin.settings.client_promo_changed", targetId: "UK:WELCOME5" });
      expect(audits[0].payload.from.isActive).to.equal(true);
    });
  });
});
