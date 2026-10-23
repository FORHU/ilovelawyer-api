import { expect } from "chai";
import { describe, it, before, after } from "mocha";
import crypto from "crypto";
import { PaymentPlan } from "@prisma/client";
import prisma from "../src/lib/prisma";
import PaymentPlanSvc from "../src/services/payment-plan.service";

const rejection = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (err) {
    return err as Error;
  }
  return null;
};

describe("PaymentPlanSvc", () => {
  const adminId = crypto.randomUUID();
  let tenantId: string;
  const code = `test-${crypto.randomUUID().slice(0, 8)}`;
  const createdPlanIds: string[] = [];

  before(async () => {
    await prisma.user.create({ data: { id: adminId, email: `pp-admin-${adminId}@example.com`, username: `pp-admin-${adminId}`, role: "ADMIN" } });
    const tenant = await prisma.tenant.findUnique({ where: { code: "PH" }, select: { id: true } });
    tenantId = tenant!.id;
  });

  after(async () => {
    await prisma.paymentPlan.deleteMany({ where: { id: { in: createdPlanIds } } });
    await prisma.user.delete({ where: { id: adminId } }).catch(() => undefined);
  });

  it("creates a tier for a tenant", async () => {
    const plan = await PaymentPlanSvc.create("PH", { code, name: "Test Tier", level: 9, feeUsd: 20, includedAllowanceUsd: 10, caseLimit: 5 }, adminId);
    createdPlanIds.push(plan.id);
    expect(plan.tenantId).to.equal(tenantId);
    expect(plan.planType).to.equal("B2B_SUBSCRIPTION");
    expect(plan.code).to.equal(code);
    expect(plan.feeUsd).to.equal(20);
    expect(plan.includedAllowanceUsd).to.equal(10);
    expect(plan.caseLimit).to.equal(5);
    expect(plan.isActive).to.equal(true);
  });

  it("refuses a negative fee or allowance", async () => {
    const err = await rejection(() => PaymentPlanSvc.create("PH", { code: `${code}-neg`, name: "Bad", feeUsd: -1, includedAllowanceUsd: 10, caseLimit: 5 }, adminId));
    expect(err?.message).to.match(/negative/i);
  });

  it("refuses an unknown tenant code", async () => {
    const err = await rejection(() => PaymentPlanSvc.create("XX" as never, { code: `${code}-xx`, name: "Bad", feeUsd: 1, includedAllowanceUsd: 1, caseLimit: 1 }, adminId));
    expect(err?.message).to.match(/unknown tenant/i);
  });

  it("refuses a duplicate code for the same tenant", async () => {
    const err = await rejection(() => PaymentPlanSvc.create("PH", { code, name: "Dup", feeUsd: 1, includedAllowanceUsd: 1, caseLimit: 1 }, adminId));
    expect(err?.message).to.match(/already exists/i);
  });

  it("updates a tier's fee/allowance/case limit", async () => {
    const plan = await PaymentPlanSvc.create("PH", { code: `${code}-upd`, name: "Updatable", feeUsd: 20, includedAllowanceUsd: 10, caseLimit: 5 }, adminId);
    createdPlanIds.push(plan.id);
    const updated = await PaymentPlanSvc.update(plan.id, { feeUsd: 55, includedAllowanceUsd: 33, caseLimit: 12 }, adminId);
    expect(updated.feeUsd).to.equal(55);
    expect(updated.includedAllowanceUsd).to.equal(33);
    expect(updated.caseLimit).to.equal(12);
  });

  it("throws on updating an unknown tier", async () => {
    const err = await rejection(() => PaymentPlanSvc.update("not-a-real-id", { feeUsd: 1 }, adminId));
    expect(err?.message).to.match(/unknown/i);
  });

  it("soft-disables and reactivates a tier without deleting it", async () => {
    const plan = await PaymentPlanSvc.create("PH", { code: `${code}-active`, name: "Togglable", feeUsd: 20, includedAllowanceUsd: 10, caseLimit: 5 }, adminId);
    createdPlanIds.push(plan.id);

    const disabled = await PaymentPlanSvc.setActive(plan.id, false, adminId);
    expect(disabled.isActive).to.equal(false);
    expect(await prisma.paymentPlan.findUnique({ where: { id: plan.id } })).to.not.equal(null);

    const reactivated = await PaymentPlanSvc.setActive(plan.id, true, adminId);
    expect(reactivated.isActive).to.equal(true);
  });

  it("lists every active and inactive tier for a tenant, ordered by level", async () => {
    const plans = await PaymentPlanSvc.listForTenant(tenantId);
    const codes = plans.filter((p: PaymentPlan) => p.code === code).map((p: PaymentPlan) => p.code);
    expect(codes).to.include(code);
    for (let i = 1; i < plans.length; i++) expect(plans[i].level).to.be.at.least(plans[i - 1].level);
  });

  it("lists every tenant's tiers for the admin settings page", async () => {
    const all = await PaymentPlanSvc.listForAdmin();
    const ph = all.find((t: { code: string }) => t.code === "PH");
    expect(ph).to.not.equal(undefined);
    expect(ph!.paymentPlans.some((p: PaymentPlan) => p.code === code)).to.equal(true);
  });
});
