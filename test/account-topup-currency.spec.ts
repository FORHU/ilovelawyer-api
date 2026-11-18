/** A lawyer's account AI top-up in their site's currency (AccountTopUpPricingSvc,
 * AccountTopUpBillingSvc): won on KR at an admin-set rate per dollar of AI usage, dollars on PH and
 * UK. Against the real database; the KR and PH top-up settings are put back as they were, and Stripe
 * is stubbed. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after } from "mocha";
import request from "supertest";
import app from "../src/app";
import loginToken from "../src/utils/loginToken";
import type { Prisma } from "@prisma/client";
import prisma from "../src/lib/prisma";
import AccountTopUpPricingSvc from "../src/services/account-topup-pricing.service";
import AccountTopUpBillingSvc from "../src/services/account-topup-billing.service";
import PaymentPlanBillingSvc from "../src/services/payment-plan-billing.service";
import * as provider from "../src/payments/account-topup-provider";
import { TENANT_SETTING_KEYS } from "../src/constants/tenant-settings.constants";

async function errorOf(promise: Promise<unknown>): Promise<{ status?: number; code?: string; message?: string } | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err: any) {
    return { status: err.statusCode, code: err.code, message: err.message };
  }
}

describe("Account AI top-up in the site's currency", function () {
  this.timeout(20_000);
  const adminId = crypto.randomUUID();
  const lawyerId = crypto.randomUUID();
  const KEYS = [TENANT_SETTING_KEYS.accountTopUpFee, TENANT_SETTING_KEYS.accountTopUpRate];
  let kr: string;
  let ph: string;
  let saved: { tenantId: string; key: string; value: Prisma.JsonValue; updatedById: string | null }[];

  before(async () => {
    kr = (await prisma.tenant.findUniqueOrThrow({ where: { code: "KR" }, select: { id: true } })).id;
    ph = (await prisma.tenant.findUniqueOrThrow({ where: { code: "PH" }, select: { id: true } })).id;
    saved = await prisma.tenantSetting.findMany({ where: { tenantId: { in: [kr, ph] }, key: { in: KEYS } }, select: { tenantId: true, key: true, value: true, updatedById: true } });
    const standard = await prisma.paymentPlan.findUniqueOrThrow({ where: { tenantId_planType_code: { tenantId: kr, planType: "B2B_SUBSCRIPTION", code: "standard" } } });
    await prisma.user.createMany({
      data: [
        { id: adminId, email: `topup-admin-${adminId}@example.com`, username: `topup-admin-${adminId}`, role: "ADMIN" },
        { id: lawyerId, email: `topup-kr-${lawyerId}@example.com`, username: `topup-kr-${lawyerId}`, role: "LAWYER", tenantId: kr, paymentPlanId: standard.id, approvalStatus: "ACTIVE" },
      ],
    });
    await AccountTopUpPricingSvc.setFee("KR", "FIXED", 1_000, adminId);
    await AccountTopUpPricingSvc.setRate("KR", 1_400, adminId);
    await AccountTopUpPricingSvc.setFee("PH", "FIXED", 0.8, adminId);
  });

  after(async () => {
    await prisma.tenantSetting.deleteMany({ where: { tenantId: { in: [kr, ph] }, key: { in: KEYS } } });
    for (const row of saved) await prisma.tenantSetting.create({ data: { ...row, value: row.value as Prisma.InputJsonValue } });
    await prisma.accountAiTopUp.deleteMany({ where: { userId: lawyerId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, lawyerId] } } });
  });

  it("offers KR lawyers won amounts", async () => {
    expect(await AccountTopUpPricingSvc.terms(kr)).to.deep.equal({ currency: "KRW", minAmount: 5_000, maxAmount: 700_000, presets: [10_000, 30_000, 70_000] });
    expect((await AccountTopUpPricingSvc.terms(ph)).currency).to.equal("USD");
  });

  it("quotes a KR top-up in won, buying dollars of AI usage at the site's rate", async () => {
    expect(await AccountTopUpPricingSvc.quote(kr, 30_000)).to.deep.equal({ currency: "KRW", topUpAmount: 30_000, feeAmount: 1_000, totalCharged: 31_000, creditUsd: 21.43 });
  });

  it("takes a percentage fee on the won amount", async () => {
    await AccountTopUpPricingSvc.setFee("KR", "PERCENT", 10, adminId);
    expect(await AccountTopUpPricingSvc.quote(kr, 30_000)).to.include({ feeAmount: 3_000, totalCharged: 33_000 });
    await AccountTopUpPricingSvc.setFee("KR", "FIXED", 1_000, adminId);
  });

  it("refuses part of a won, and amounts outside the won limits", async () => {
    for (const amount of [30_000.5, 4_000, 700_001]) {
      const err = await errorOf(AccountTopUpPricingSvc.quote(kr, amount));
      expect(err).to.include({ status: 400, code: "TOPUP_AMOUNT_OUT_OF_RANGE" });
      expect(err?.message).to.contain("₩5,000").and.contain("₩700,000");
    }
  });

  it("keeps a PH top-up in dollars, where the AI usage is the amount paid", async () => {
    expect(await AccountTopUpPricingSvc.quote(ph, 20)).to.deep.equal({ currency: "USD", topUpAmount: 20, feeAmount: 0.8, totalCharged: 20.8, creditUsd: 20 });
  });

  it("checks the rate an admin sets, and only takes one on a non-dollar site", async () => {
    expect(await errorOf(AccountTopUpPricingSvc.setRate("UK", 1, adminId))).to.include({ status: 400, code: "RATE_NOT_APPLICABLE" });
    expect(await errorOf(AccountTopUpPricingSvc.setRate("KR", 99, adminId))).to.include({ status: 400, code: "RATE_OUT_OF_RANGE" });
    expect(await errorOf(AccountTopUpPricingSvc.setFee("KR", "FIXED", 999.5, adminId))).to.include({ status: 400 });
  });

  it("lists each site's top-up currency and rate for the admin", async () => {
    const sites = await AccountTopUpPricingSvc.listForAdmin();
    expect(sites.find((t) => t.code === "KR")).to.include({ currency: "KRW", feeType: "FIXED", feeAmount: 1_000, perUsd: 1_400 });
    expect(sites.find((t) => t.code === "UK")).to.include({ currency: "USD", perUsd: null });
  });

  it("charges a KR lawyer in won at Stripe, and records the AI usage bought in dollars", async () => {
    const original = provider.createAccountTopUpCheckout;
    const sent: provider.AccountTopUpCheckoutRequest[] = [];
    (provider as any).createAccountTopUpCheckout = async (request: provider.AccountTopUpCheckoutRequest) => {
      sent.push(request);
      return { externalId: `cs_${crypto.randomUUID()}`, clientSecret: "secret", publishableKey: "pk_test" };
    };
    try {
      const result = await AccountTopUpBillingSvc.startCheckout(lawyerId, 30_000, undefined);
      expect(result).to.include({ currency: "KRW", topUpAmount: 30_000, feeAmount: 1_000, totalCharged: 31_000, creditUsd: 21.43 });
      expect(sent[0]).to.include({ currency: "KRW", totalChargedMinor: 31_000 });
      const row = await prisma.accountAiTopUp.findUniqueOrThrow({ where: { id: result.topUpId } });
      expect(row).to.include({ currency: "KRW", topUpAmountMinor: 30_000, feeAmountMinor: 1_000, totalChargedMinor: 31_000, topUpAmountUsd: 21.43 });
      expect(await AccountTopUpBillingSvc.status(lawyerId, result.topUpId)).to.include({ currency: "KRW", totalCharged: 31_000 });
    } finally {
      (provider as any).createAccountTopUpCheckout = original;
    }
  });

  it("shows a KR lawyer's free AI credit in won", async () => {
    await prisma.user.update({ where: { id: lawyerId }, data: { freeCreditUsd: 5 } });
    const { body } = await request(app).get("/api/users/me/free-credit").set("Authorization", `Bearer ${loginToken(lawyerId, false).accessToken}`).expect(200);
    expect(body.creditUsd).to.equal(5);
    expect(body.display.credit).to.deep.equal({ amountMinor: 7_000, currency: "KRW" });
    expect(body.display.left.currency).to.equal("KRW");
    await prisma.user.update({ where: { id: lawyerId }, data: { freeCreditUsd: null } });
  });

  it("shows a KR plan's AI usage in won", async () => {
    const { plans } = await PaymentPlanBillingSvc.options(lawyerId);
    for (const plan of plans) expect(plan.aiUsage).to.deep.equal({ amountMinor: Math.round(plan.includedAllowanceUsd * 1_400), currency: "KRW" });
  });
});
