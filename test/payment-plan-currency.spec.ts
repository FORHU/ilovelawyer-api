/** Changing the currency a site's lawyers are charged in (PUT /api/admin/settings/tenants/:code
 * /payment-plans/currency, PaymentPlanSvc.changeCurrency): every tier repriced at once, the AI top-up
 * following. Against the real database on PH (KR has a live subscription in dev): PH's tiers and
 * top-up settings are put back exactly as they were, and Stripe is stubbed. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after } from "mocha";
import request from "supertest";
import type { PaymentPlan, Prisma } from "@prisma/client";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import loginToken from "../src/utils/loginToken";
import AccountTopUpPricingSvc from "../src/services/account-topup-pricing.service";
import PaymentPlanBillingSvc from "../src/services/payment-plan-billing.service";
import * as provider from "../src/payments/payment-plan-subscription-provider";
import { TENANT_SETTING_KEYS } from "../src/constants/tenant-settings.constants";

describe("Changing a site's lawyer currency", function () {
  this.timeout(30_000);
  const adminId = crypto.randomUUID();
  const lawyerId = crypto.randomUUID();
  const KEYS = [TENANT_SETTING_KEYS.accountTopUpFee, TENANT_SETTING_KEYS.accountTopUpRate];
  const subIds: string[] = [];
  let ph: string;
  let tiers: PaymentPlan[];
  let savedSettings: { tenantId: string; key: string; value: Prisma.JsonValue; updatedById: string | null }[];

  const auth = (id: string) => ({ Authorization: `Bearer ${loginToken(id, false).accessToken}` });
  const change = (body: object, code = "PH") => request(app).put(`/api/admin/settings/tenants/${code}/payment-plans/currency`).set(auth(adminId)).send(body);
  // ₱1,099 / ₱2,799 / ... for every PH tier, hidden ones included.
  const pesoPrices = () => tiers.map((t, i) => ({ planId: t.id, priceMinor: 109_900 + i * 170_000 }));

  before(async () => {
    ph = (await prisma.tenant.findUniqueOrThrow({ where: { code: "PH" }, select: { id: true } })).id;
    tiers = await prisma.paymentPlan.findMany({ where: { tenantId: ph, planType: "B2B_SUBSCRIPTION" }, orderBy: { level: "asc" } });
    if (tiers.some((t) => t.currency !== "USD")) throw new Error("This spec expects PH's tiers in US dollars");
    savedSettings = await prisma.tenantSetting.findMany({ where: { tenantId: ph, key: { in: KEYS } }, select: { tenantId: true, key: true, value: true, updatedById: true } });
    const standard = tiers.find((t) => t.isActive) ?? tiers[0];
    await prisma.user.createMany({
      data: [
        { id: adminId, email: `currency-admin-${adminId}@example.com`, username: `currency-admin-${adminId}`, role: "ADMIN" },
        { id: lawyerId, email: `currency-ph-${lawyerId}@example.com`, username: `currency-ph-${lawyerId}`, role: "LAWYER", tenantId: ph, paymentPlanId: standard.id, approvalStatus: "ACTIVE" },
      ],
    });
    await AccountTopUpPricingSvc.setFee("PH", "FIXED", 0.8, adminId);
  });

  after(async () => {
    await prisma.paymentPlanSubscription.deleteMany({ where: { id: { in: subIds } } });
    for (const t of tiers) {
      await prisma.paymentPlan.update({
        where: { id: t.id },
        data: { priceMinor: t.priceMinor, currency: t.currency, feeUsd: t.feeUsd, stripePriceAmountMinor: t.stripePriceAmountMinor, updatedById: t.updatedById, updatedAt: t.updatedAt },
      });
    }
    await prisma.tenantSetting.deleteMany({ where: { tenantId: ph, key: { in: KEYS } } });
    for (const row of savedSettings) await prisma.tenantSetting.create({ data: { ...row, value: row.value as Prisma.InputJsonValue } });
    await prisma.user.updateMany({ where: { id: { in: [adminId, lawyerId] } }, data: { paymentPlanId: null } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, lawyerId] } } });
  });

  it("offers the admin the currencies, and each site's local default", async () => {
    const { body } = await request(app).get("/api/admin/settings").set(auth(adminId)).expect(200);
    expect(body.planCurrencies.map((c: { code: string }) => c.code)).to.include.members(["USD", "PHP", "KRW"]);
    const site = body.tenants.find((t: { code: string }) => t.code === "PH");
    expect(site).to.include({ planCurrency: "USD", defaultPlanCurrency: "PHP" });
    expect(body.tenants.find((t: { code: string }) => t.code === "KR")).to.include({ planCurrency: "KRW", defaultPlanCurrency: "KRW" });
  });

  it("is for platform admins only", async () => {
    await request(app).put("/api/admin/settings/tenants/PH/payment-plans/currency").set(auth(lawyerId)).send({ currency: "PHP", prices: pesoPrices() }).expect(403);
  });

  it("needs a price for every tier, in range, and a different currency", async () => {
    expect((await change({ currency: "PHP", prices: pesoPrices().slice(1) }).expect(400)).body.code).to.equal("PRICES_INCOMPLETE");
    const tooMuch = pesoPrices().map((p) => ({ ...p, priceMinor: 60_000_001 }));
    expect((await change({ currency: "PHP", prices: tooMuch }).expect(400)).body.code).to.equal("PRICE_OUT_OF_RANGE");
    expect((await change({ currency: "USD", prices: tiers.map((t) => ({ planId: t.id, priceMinor: 2_000 })) }).expect(400)).body.code).to.equal("CURRENCY_UNCHANGED");
    await change({ currency: "EUR", prices: pesoPrices() }).expect(400);
  });

  it("refuses while a lawyer on the site has a live subscription", async () => {
    const live = await prisma.paymentPlanSubscription.create({ data: { userId: lawyerId, paymentPlanId: tiers[0].id, provider: "STRIPE", status: "ACTIVE" } });
    subIds.push(live.id);
    const { body } = await change({ currency: "PHP", prices: pesoPrices() }).expect(409);
    expect(body.code).to.equal("CURRENCY_LOCKED");
    expect((await prisma.paymentPlan.findUniqueOrThrow({ where: { id: tiers[0].id } })).currency).to.equal("USD");
    await prisma.paymentPlanSubscription.update({ where: { id: live.id }, data: { status: "CANCELED" } });
  });

  it("moves PH to pesos: every tier, the open checkouts, and the AI top-up", async () => {
    const open = await prisma.paymentPlanSubscription.create({
      data: { userId: lawyerId, paymentPlanId: tiers[0].id, provider: "STRIPE", status: "PENDING", checkoutSessionId: `cs_${crypto.randomUUID()}` },
    });
    subIds.push(open.id);
    const original = provider.expirePaymentPlanCheckout;
    const expired: string[] = [];
    (provider as any).expirePaymentPlanCheckout = async (sessionId: string) => {
      expired.push(sessionId);
    };
    try {
      const { body } = await change({ currency: "PHP", prices: pesoPrices() }).expect(200);
      expect(body).to.include({ currency: "PHP", checkoutsClosed: 1, topUpFeeReset: true });
    } finally {
      (provider as any).expirePaymentPlanCheckout = original;
    }

    const after = await prisma.paymentPlan.findMany({ where: { tenantId: ph, planType: "B2B_SUBSCRIPTION" }, orderBy: { level: "asc" } });
    expect(after.map((t) => [t.currency, t.priceMinor, t.feeUsd, t.stripePriceAmountMinor])).to.deep.equal(pesoPrices().map((p) => ["PHP", p.priceMinor, 0, null]));
    expect(expired).to.deep.equal([open.checkoutSessionId]);
    expect((await prisma.paymentPlanSubscription.findUniqueOrThrow({ where: { id: open.id } })).status).to.equal("EXPIRED");

    // The dollar fee doesn't carry over: pesos, at the peso defaults (₱50 fee, ₱58 per $1).
    expect(await AccountTopUpPricingSvc.terms(ph)).to.include({ currency: "PHP", minAmount: 300, maxAmount: 30_000 });
    expect(await AccountTopUpPricingSvc.quote(ph, 1_000)).to.deep.equal({ currency: "PHP", topUpAmount: 1_000, feeAmount: 50, totalCharged: 1_050, creditUsd: 17.24 });
    const site = (await AccountTopUpPricingSvc.listForAdmin()).find((t) => t.code === "PH");
    expect(site).to.include({ currency: "PHP", feeType: "FIXED", feeAmount: 50, perUsd: 58, feeUpdatedAt: null });

    // What a PH lawyer is offered: the plans and their AI usage in pesos.
    const { plans } = await PaymentPlanBillingSvc.options(lawyerId);
    for (const plan of plans) {
      expect(plan.price.currency).to.equal("PHP");
      expect(plan.aiUsage).to.deep.equal({ amountMinor: Math.round(plan.includedAllowanceUsd * 58 * 100), currency: "PHP" });
    }
  });

  it("prices a new tier in the site's new currency", async () => {
    const { body } = await request(app)
      .post("/api/admin/settings/tenants/PH/payment-plans")
      .set(auth(adminId))
      .send({ code: `peso-${crypto.randomUUID().slice(0, 8)}`, name: "Peso tier", priceMinor: 99_900, includedAllowanceUsd: 5, caseLimit: 1 })
      .expect(201);
    try {
      expect(body).to.include({ currency: "PHP", priceMinor: 99_900, feeUsd: 0 });
    } finally {
      await prisma.paymentPlan.delete({ where: { id: body.id } });
    }
  });

  it("ignores a fixed fee or rate saved in another currency", async () => {
    // A row from when PH was in dollars, as if left behind.
    await prisma.tenantSetting.create({ data: { tenantId: ph, key: TENANT_SETTING_KEYS.accountTopUpFee, value: { feeType: "FIXED", feeAmount: 0.8, currency: "USD" }, updatedById: adminId } });
    try {
      expect(await AccountTopUpPricingSvc.fee(ph, "PHP")).to.deep.equal({ feeType: "FIXED", feeAmount: 50 });
      await AccountTopUpPricingSvc.setFee("PH", "FIXED", 40, adminId);
      expect(await AccountTopUpPricingSvc.fee(ph, "PHP")).to.deep.equal({ feeType: "FIXED", feeAmount: 40 });
    } finally {
      await prisma.tenantSetting.deleteMany({ where: { tenantId: ph, key: TENANT_SETTING_KEYS.accountTopUpFee } });
    }
  });
});
