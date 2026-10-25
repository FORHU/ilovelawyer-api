/** What lawyers pay, edited by admins per tenant (#598, LawyerPricingSvc): the introduction fee and
 * the AI top-up packs, through the real admin routes against the real database. Works on the PH
 * tenant's seeded rows (lawyer_pricing_seed), so the UK hand-off tests running alongside keep their
 * prices, and puts them back afterwards. Security audit rows are captured in memory. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { redis } from "../src/lib/redis";
import { ACCESS_TOKEN_SECRET } from "../src/config";
import SecurityAuditRepo from "../src/repositories/security-audit.repository";
import LawyerPricingSvc from "../src/services/lawyer-pricing.service";
import { LAWYER_PRICING_DEFAULTS, lawyerPricingCacheKey } from "../src/constants/lawyer-pricing.constants";

const tokenFor = (userId: string) => jwt.sign({ userId }, ACCESS_TOKEN_SECRET, { expiresIn: "1h" });

describe("Lawyer pricing in admin (#598)", () => {
  const adminId = crypto.randomUUID();
  const lawyerId = crypto.randomUUID();
  let tenantId: string;
  let asAdmin: { Authorization: string };
  let auditRows: any[];
  let savedAuditCreate: unknown;
  let seeded: { id: string; priceMinor: number | null; creditMinor: number | null; name: string; isActive: boolean; createdAt: Date; updatedAt: Date; updatedById: string | null }[];

  const admin = () => ({
    get: () => request(app).get("/api/admin/settings/lawyer-pricing").set(asAdmin),
    fee: (body: object) => request(app).patch("/api/admin/settings/tenants/PH/lawyer-pricing/intro-fee").set(asAdmin).send(body),
    newPack: (body: object) => request(app).post("/api/admin/settings/tenants/PH/lawyer-pricing/packs").set(asAdmin).send(body),
    pack: (id: string, body: object) => request(app).patch(`/api/admin/settings/lawyer-pricing/packs/${id}`).set(asAdmin).send(body),
  });

  before(async () => {
    tenantId = (await prisma.tenant.findUniqueOrThrow({ where: { code: "PH" } })).id;
    await prisma.user.createMany({
      data: [
        { id: adminId, email: `lp-admin-${adminId}@example.com`, username: `lp-admin-${adminId}`, role: "ADMIN" },
        { id: lawyerId, email: `lp-lawyer-${lawyerId}@example.com`, username: `lp-lawyer-${lawyerId}`, role: "LAWYER", tenantId },
      ],
    });
    asAdmin = { Authorization: `Bearer ${tokenFor(adminId)}` };
    seeded = await prisma.paymentPlan.findMany({
      where: { tenantId, planType: { in: ["LAWYER_INTRO_FEE", "LAWYER_AI_TOP_UP"] } },
      select: { id: true, priceMinor: true, creditMinor: true, name: true, isActive: true, createdAt: true, updatedAt: true, updatedById: true },
    });
  });

  after(async () => {
    await prisma.paymentPlan.deleteMany({ where: { tenantId, planType: "LAWYER_AI_TOP_UP", NOT: { id: { in: seeded.map((s) => s.id) } } } });
    // As they were, down to who last changed them and when (the admin page shows "As seeded").
    for (const { id, createdAt: _createdAt, ...row } of seeded) await prisma.paymentPlan.update({ where: { id }, data: row });
    await redis.del(lawyerPricingCacheKey(tenantId));
    await prisma.user.deleteMany({ where: { id: { in: [adminId, lawyerId] } } });
  });

  beforeEach(async () => {
    auditRows = [];
    savedAuditCreate = (SecurityAuditRepo as any).create;
    (SecurityAuditRepo as any).create = async (data: object) => {
      auditRows.push(data);
      return { id: "row", createdAt: new Date(), ...data };
    };
    await redis.del(lawyerPricingCacheKey(tenantId));
  });
  afterEach(() => {
    (SecurityAuditRepo as any).create = savedAuditCreate;
  });

  it("lists every tenant's fee and packs, seeded with today's prices", async () => {
    const { body } = await admin().get().expect(200);
    expect(body).to.deep.include({ currency: "GBP", minMinor: 30, maxMinor: 100_000 });
    const ph = body.tenants.find((t: { code: string }) => t.code === "PH");
    expect(ph.introFee).to.deep.include({ code: "intro", priceMinor: LAWYER_PRICING_DEFAULTS.introFee.priceMinor, currency: "GBP" });
    expect(ph.packs.map((p: any) => [p.code, p.priceMinor, p.creditMinor])).to.deep.include(["standard", 4000, 2400]);
  });

  it("needs an admin", async () => {
    await request(app).get("/api/admin/settings/lawyer-pricing").set({ Authorization: `Bearer ${tokenFor(lawyerId)}` }).expect(403);
  });

  it("changes the introduction fee: the next read sees it at once, and the change is audited", async () => {
    expect((await LawyerPricingSvc.forTenant(tenantId)).introFee.amountMinor).to.equal(5000); // cached now
    const { body } = await admin().fee({ priceMinor: 7500 }).expect(200);
    expect(body.priceMinor).to.equal(7500);
    expect((await LawyerPricingSvc.forTenant(tenantId)).introFee).to.deep.equal({ amountMinor: 7500, currency: "GBP" });
    const audit = auditRows.find((r) => r.action === "admin.settings.lawyer_price_changed");
    expect(audit).to.deep.include({ actorId: adminId, targetType: "lawyer_price", targetId: "PH:intro" });
    expect(audit.payload).to.deep.equal({ from: { priceMinor: 5000 }, to: { priceMinor: 7500 } });
  });

  it("refuses a fee below Stripe's minimum or above the ceiling", async () => {
    expect((await admin().fee({ priceMinor: 29 }).expect(400)).body.code).to.equal("PRICE_OUT_OF_RANGE");
    expect((await admin().fee({ priceMinor: 100_001 }).expect(400)).body.code).to.equal("PRICE_OUT_OF_RANGE");
    await admin().fee({}).expect(400);
  });

  it("adds a pack after the others, and lawyers of that region are offered it", async () => {
    const { body } = await admin().newPack({ code: "Small", name: "Small", priceMinor: 1000, creditMinor: 600 }).expect(201);
    expect(body).to.deep.include({ code: "small", planType: "LAWYER_AI_TOP_UP", priceMinor: 1000, creditMinor: 600, currency: "GBP", level: 1 });
    expect(auditRows.find((r) => r.action === "admin.settings.lawyer_price_created")).to.deep.include({ targetId: "PH:small" });

    const offered = await request(app).get("/api/billing/top-up-packs").set({ Authorization: `Bearer ${tokenFor(lawyerId)}` }).expect(200);
    expect(offered.body.map((p: { id: string }) => p.id)).to.deep.equal(["standard", "small"]);
    expect(offered.body[1]).to.deep.equal({ id: "small", name: "Small", price: { amountMinor: 1000, currency: "GBP" }, credit: { amountMinor: 600, currency: "GBP" } });

    await admin().newPack({ code: "small", name: "Again", priceMinor: 1000, creditMinor: 600 }).expect(409);
  });

  it("edits a pack, and a pack turned off is no longer offered", async () => {
    const standard = seeded.find((s) => s.creditMinor !== null)!;
    await admin().pack(standard.id, { priceMinor: 3500, creditMinor: 2500 }).expect(200);
    expect((await LawyerPricingSvc.forTenant(tenantId)).topUpPacks.find((p) => p.id === "standard")).to.deep.include({
      price: { amountMinor: 3500, currency: "GBP" },
      credit: { amountMinor: 2500, currency: "GBP" },
    });

    await admin().pack(standard.id, { isActive: false }).expect(200);
    expect((await LawyerPricingSvc.forTenant(tenantId)).topUpPacks.map((p) => p.id)).to.not.include("standard");
  });

  it("doesn't treat the fee row as a pack", async () => {
    const fee = seeded.find((s) => s.creditMinor === null)!;
    await admin().pack(fee.id, { name: "x" }).expect(404);
  });
});
