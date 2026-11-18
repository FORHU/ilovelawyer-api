/** PaymentPlanStripeSyncSvc.ensureStripePrice: a tier's monthly Stripe Price is in the tier's own
 * currency, at its price. On KR that's won, which Stripe treats as zero-decimal: ₩29,000 goes to
 * Stripe as 29000, not ×100. Against the real database (one temporary, inactive tier); Stripe is
 * stubbed. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import prisma from "../src/lib/prisma";
import * as stripeClientModule from "../src/payments/stripe-client";
import PaymentPlanStripeSyncSvc from "../src/services/payment-plan-stripe-sync.service";

describe("Stripe price of a plan", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const created: string[] = [];
  let calls: { method: string; args: any[] }[];
  let saved: typeof stripeClientModule.stripeClient;
  /** Every made-up Stripe id is unique across the file: stripeProductId is a unique column. */
  let next = 0;
  const fakeId = (kind: string) => `${kind}_${suffix}_${++next}`;

  const fakeStripe = {
    products: { create: async (...args: any[]) => (calls.push({ method: "products.create", args }), { id: fakeId("prod") }) },
    prices: {
      create: async (...args: any[]) => (calls.push({ method: "prices.create", args }), { id: fakeId("price") }),
      update: async (...args: any[]) => (calls.push({ method: "prices.update", args }), {}),
    },
  };

  const tier = async (tenantCode: "KR" | "UK", priceMinor: number, currency: string) => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { code: tenantCode }, select: { id: true } });
    const plan = await prisma.paymentPlan.create({
      data: { tenantId: tenant.id, planType: "B2B_SUBSCRIPTION", code: `sync-${tenantCode}-${suffix}-${++next}`, name: "Sync Test", priceMinor, currency, feeUsd: 0, includedAllowanceUsd: 0, level: 99, isActive: false },
    });
    created.push(plan.id);
    return plan;
  };

  before(() => {
    saved = stripeClientModule.stripeClient;
  });
  beforeEach(() => {
    calls = [];
    (stripeClientModule as any).stripeClient = () => fakeStripe;
  });
  afterEach(() => {
    (stripeClientModule as any).stripeClient = saved;
  });
  after(async () => {
    await prisma.paymentPlan.deleteMany({ where: { id: { in: created } } });
  });

  it("mints a KR tier's Price in won, at the won amount", async () => {
    const plan = await tier("KR", 29_000, "KRW");
    const priceId = await PaymentPlanStripeSyncSvc.ensureStripePrice(plan);

    const [params, options] = calls.find((c) => c.method === "prices.create")!.args;
    expect(params).to.include({ currency: "krw", unit_amount: 29_000 });
    expect(options.idempotencyKey).to.contain("-KRW-29000-");
    expect(await prisma.paymentPlan.findUniqueOrThrow({ where: { id: plan.id } })).to.include({ stripePriceId: priceId, stripePriceAmountMinor: 29_000 });

    // Unchanged: the same Price, no Stripe call.
    calls = [];
    expect(await PaymentPlanStripeSyncSvc.ensureStripePrice(await prisma.paymentPlan.findUniqueOrThrow({ where: { id: plan.id } }))).to.equal(priceId);
    expect(calls).to.have.length(0);
  });

  it("mints a new won Price for a tier that had a dollar one, and archives the old one", async () => {
    const plan = await tier("KR", 69_000, "KRW");
    // As the payment_plan_currency migration leaves a KR tier that had a USD Price.
    const moved = await prisma.paymentPlan.update({ where: { id: plan.id }, data: { stripeProductId: `prod_old_${suffix}`, stripePriceId: `price_usd_${suffix}`, stripePriceAmountMinor: null } });
    await PaymentPlanStripeSyncSvc.ensureStripePrice(moved);
    expect(calls.find((c) => c.method === "prices.create")!.args[0]).to.include({ currency: "krw", unit_amount: 69_000, product: `prod_old_${suffix}` });
    expect(calls.find((c) => c.method === "prices.update")!.args).to.deep.equal([`price_usd_${suffix}`, { active: false }]);
  });

  it("keeps a UK tier in dollars, in cents", async () => {
    const plan = await tier("UK", 2_000, "USD");
    await PaymentPlanStripeSyncSvc.ensureStripePrice(plan);
    expect(calls.find((c) => c.method === "prices.create")!.args[0]).to.include({ currency: "usd", unit_amount: 2_000 });
  });
});
