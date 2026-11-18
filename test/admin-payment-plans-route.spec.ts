import { expect } from "chai";
import request from "supertest";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { describe, it, before, after } from "mocha";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { ACCESS_TOKEN_SECRET } from "../src/config";

function tokenFor(userId: string) {
  return jwt.sign({ userId }, ACCESS_TOKEN_SECRET, { expiresIn: "1h" });
}

describe("Admin payment-plan routes", () => {
  const adminId = crypto.randomUUID();
  const lawyerId = crypto.randomUUID();
  let token: string;
  const code = `route-test-${crypto.randomUUID().slice(0, 8)}`;
  const createdPlanIds: string[] = [];

  before(async () => {
    await prisma.user.create({ data: { id: adminId, email: `pp-route-admin-${adminId}@example.com`, username: `pp-route-admin-${adminId}`, role: "ADMIN" } });
    await prisma.user.create({ data: { id: lawyerId, email: `pp-route-lawyer-${lawyerId}@example.com`, username: `pp-route-lawyer-${lawyerId}`, role: "LAWYER" } });
    token = tokenFor(adminId);
  });

  after(async () => {
    await prisma.user.update({ where: { id: lawyerId }, data: { paymentPlanId: null } });
    await prisma.paymentPlan.deleteMany({ where: { id: { in: createdPlanIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, lawyerId] } } });
  });

  it("creates, lists, updates, and soft-disables a tier through the admin API", async () => {
    const created = await request(app)
      .post("/api/admin/settings/tenants/PH/payment-plans")
      .set("Authorization", `Bearer ${token}`)
      .send({ code, name: "Route Test Tier", priceMinor: 2000, includedAllowanceUsd: 10, caseLimit: 5 });
    expect(created.status).to.equal(201);
    expect(created.body.code).to.equal(code);
    createdPlanIds.push(created.body.id);
    const planId = created.body.id;

    const listed = await request(app).get("/api/admin/settings/tenants/PH/payment-plans").set("Authorization", `Bearer ${token}`);
    expect(listed.status).to.equal(200);
    expect(listed.body.paymentPlans.some((p: { id: string }) => p.id === planId)).to.equal(true);

    const updated = await request(app)
      .patch(`/api/admin/settings/tenants/PH/payment-plans/${planId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ priceMinor: 7700 });
    expect(updated.status).to.equal(200);
    expect(updated.body).to.include({ priceMinor: 7700, currency: "USD" });

    // Assign a lawyer to the tier, then confirm deactivating it never deletes the row (the
    // lawyer's User.paymentPlanId must keep resolving).
    await prisma.user.update({ where: { id: lawyerId }, data: { paymentPlanId: planId } });

    const deactivated = await request(app).delete(`/api/admin/settings/tenants/PH/payment-plans/${planId}`).set("Authorization", `Bearer ${token}`);
    expect(deactivated.status).to.equal(200);
    expect(deactivated.body.isActive).to.equal(false);

    const stillThere = await prisma.user.findUnique({ where: { id: lawyerId }, select: { paymentPlanId: true } });
    expect(stillThere?.paymentPlanId).to.equal(planId);

    const reactivated = await request(app)
      .patch(`/api/admin/settings/tenants/PH/payment-plans/${planId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ isActive: true });
    expect(reactivated.status).to.equal(200);
    expect(reactivated.body.isActive).to.equal(true);
  });

  it("refuses a non-admin", async () => {
    const lawyerToken = tokenFor(lawyerId);
    const res = await request(app)
      .post("/api/admin/settings/tenants/PH/payment-plans")
      .set("Authorization", `Bearer ${lawyerToken}`)
      .send({ code: `${code}-denied`, name: "Nope", priceMinor: 100, includedAllowanceUsd: 1, caseLimit: 1 });
    expect(res.status).to.equal(403);
  });

  it("rejects an invalid payload with 400", async () => {
    const res = await request(app)
      .post("/api/admin/settings/tenants/PH/payment-plans")
      .set("Authorization", `Bearer ${token}`)
      .send({ code: "", name: "Bad", priceMinor: -5, includedAllowanceUsd: 1, caseLimit: 1 });
    expect(res.status).to.equal(400);
  });

  it("rejects a fee that isn't a whole number of the smallest unit", async () => {
    const res = await request(app)
      .post("/api/admin/settings/tenants/KR/payment-plans")
      .set("Authorization", `Bearer ${token}`)
      .send({ code: `${code}-frac`, name: "Bad", priceMinor: 29000.5, includedAllowanceUsd: 1, caseLimit: 1 });
    expect(res.status).to.equal(400);
  });

  it("gives each site's plan currency in GET /api/admin/settings", async () => {
    const res = await request(app).get("/api/admin/settings").set("Authorization", `Bearer ${token}`);
    expect(res.status).to.equal(200);
    const kr = res.body.tenants.find((t: { code: string }) => t.code === "KR");
    expect(kr.planCurrency).to.equal("KRW");
    expect(kr.paymentPlans.map((p: { code: string; priceMinor: number; currency: string }) => [p.code, p.currency])).to.deep.include(["standard", "KRW"]);
    expect(res.body.tenants.find((t: { code: string }) => t.code === "PH").planCurrency).to.equal("USD");
  });

  it("includes paymentPlans in GET /api/admin/settings", async () => {
    const res = await request(app).get("/api/admin/settings").set("Authorization", `Bearer ${token}`);
    expect(res.status).to.equal(200);
    const ph = res.body.tenants.find((t: { code: string }) => t.code === "PH");
    expect(ph.paymentPlans).to.be.an("array");
    expect(ph.paymentPlans.length).to.be.greaterThan(0);
  });
});
