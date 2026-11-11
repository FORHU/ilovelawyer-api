/** The admin's Lawyer subscriptions list (GET /api/admin/lawyer-subscriptions): lawyers' plan
 * subscriptions, newest first, with the firm, the plan, the period, and the filters and summary the
 * admin page shows. Against the real database: it only looks at its own rows, since others may be
 * there too. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after } from "mocha";
import request from "supertest";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import loginToken from "../src/utils/loginToken";

describe("admin lawyer subscriptions", function () {
  this.timeout(20_000);
  const adminId = crypto.randomUUID();
  const firmLawyerId = crypto.randomUUID();
  const soloLawyerId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const soloOrgId = crypto.randomUUID();
  const suffix = crypto.randomUUID().slice(0, 8);
  const ids: Record<string, string> = {};
  let proId: string;
  let standardId: string;

  const auth = (id: string) => ({ Authorization: `Bearer ${loginToken(id, false).accessToken}` });
  const list = (query = "") => request(app).get(`/api/admin/lawyer-subscriptions?limit=100${query}`).set(auth(adminId));
  const mine = (body: { data: { id: string }[] }) => body.data.filter((s) => Object.values(ids).includes(s.id));
  const DAY_MS = 24 * 60 * 60 * 1000;

  before(async () => {
    const tenant = await prisma.tenant.upsert({ where: { code: "UK" }, update: {}, create: { code: "UK", name: "United Kingdom" } });
    const user = (id: string, name: string, role: "LAWYER" | "ADMIN") => ({ id, email: `subs-${id}@example.com`, username: `subs-${id}`, name, role, tenantId: tenant.id });
    await prisma.user.createMany({ data: [user(adminId, "Ann Admin", "ADMIN"), user(firmLawyerId, "Harriet Okafor", "LAWYER"), user(soloLawyerId, "Daniel Price", "LAWYER")] });
    await prisma.organization.create({
      data: { id: orgId, name: "Okafor & Lane LLP", slug: `subs-${orgId}`, tenantId: tenant.id, createdById: firmLawyerId, members: { create: { userId: firmLawyerId, role: "OWNER", status: "ACCEPTED" } } },
    });
    await prisma.organization.create({
      data: { id: soloOrgId, name: "Daniel Price", slug: `subs-${soloOrgId}`, tenantId: tenant.id, createdById: soloLawyerId, isPersonal: true, members: { create: { userId: soloLawyerId, role: "OWNER", status: "ACCEPTED" } } },
    });
    const plan = (code: string, name: string, feeUsd: number, level: number) =>
      prisma.paymentPlan.create({ data: { tenantId: tenant.id, planType: "B2B_SUBSCRIPTION", code: `${code}-${suffix}`, name, feeUsd, includedAllowanceUsd: 0, level, isActive: false } });
    standardId = (await plan("standard", "Standard", 49, 1)).id;
    proId = (await plan("pro", "Pro", 99, 2)).id;

    const now = Date.now();
    const period = { currentPeriodStart: new Date(now - 5 * DAY_MS), currentPeriodEnd: new Date(now + 25 * DAY_MS) };
    const sub = async (key: string, userId: string, paymentPlanId: string, data: object, ageMinutes: number) => {
      const row = await prisma.paymentPlanSubscription.create({
        data: { userId, paymentPlanId, provider: "STRIPE", createdAt: new Date(now - ageMinutes * 60_000), ...data },
      });
      ids[key] = row.id;
    };
    await sub("active", firmLawyerId, proId, { status: "ACTIVE", ...period }, 1);
    await sub("downgrading", soloLawyerId, proId, { status: "ACTIVE", ...period, scheduledPaymentPlanId: standardId }, 2);
    await sub("cancelling", firmLawyerId, standardId, { status: "ACTIVE", ...period, cancelAtPeriodEnd: true }, 3);
    await sub("pastDue", soloLawyerId, standardId, { status: "PAST_DUE", ...period, failureReason: "Your card was declined." }, 4);
    await sub("ended", firmLawyerId, standardId, { status: "CANCELED" }, 5);
    await sub("checkout", soloLawyerId, standardId, { status: "PENDING", checkoutSessionId: `cs_${crypto.randomUUID()}` }, 6);
    await sub("abandoned", soloLawyerId, standardId, { status: "EXPIRED", checkoutSessionId: `cs_${crypto.randomUUID()}` }, 7);
  });

  after(async () => {
    await prisma.paymentPlanSubscription.deleteMany({ where: { id: { in: Object.values(ids) } } });
    await prisma.paymentPlan.deleteMany({ where: { id: { in: [standardId, proId] } } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: [firmLawyerId, soloLawyerId] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, soloOrgId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, firmLawyerId, soloLawyerId] } } });
  });

  it("is for platform admins only", async () => {
    await request(app).get("/api/admin/lawyer-subscriptions").set(auth(firmLawyerId)).expect(403);
  });

  it("lists every subscription but never-paid checkouts, newest first, with the lawyer, firm and plan", async () => {
    const body = (await list().expect(200)).body;
    const rows = mine(body);
    expect(rows.map((r) => r.id)).to.deep.equal([ids.active, ids.downgrading, ids.cancelling, ids.pastDue, ids.ended, ids.checkout]);
    const [active, downgrading] = rows as unknown as {
      lawyer: { name: string; firmName: string | null };
      plan: { name: string; feeUsd: number; tenantCode: string };
      scheduledPlan: { name: string } | null;
      currentPeriodEnd: string;
    }[];
    expect(active.lawyer).to.deep.include({ name: "Harriet Okafor", firmName: "Okafor & Lane LLP" });
    expect(active.plan).to.deep.include({ name: "Pro", feeUsd: 99, tenantCode: "UK" });
    expect(active.currentPeriodEnd).to.be.a("string");
    // A solo lawyer's own workspace isn't a firm.
    expect(downgrading.lawyer).to.deep.include({ name: "Daniel Price", firmName: null });
    expect(downgrading.scheduledPlan).to.deep.include({ name: "Standard" });
  });

  it("filters: active, past due, cancelling or downgrading, ended, and open checkouts", async () => {
    const idsOf = async (status: string) => mine((await list(`&status=${status}`).expect(200)).body).map((r) => r.id);
    expect(await idsOf("ACTIVE")).to.deep.equal([ids.active]);
    expect(await idsOf("PAST_DUE")).to.deep.equal([ids.pastDue]);
    expect(await idsOf("CHANGING")).to.deep.equal([ids.downgrading, ids.cancelling]);
    expect(await idsOf("ENDED")).to.deep.equal([ids.ended]);
    expect(await idsOf("PENDING")).to.deep.equal([ids.checkout]);
    await list("&status=EXPIRED").expect(400);
  });

  it("pages, and sums what active subscriptions bill each month", async () => {
    const before = (await list().expect(200)).body.summary as { active: number; monthlyUsd: number; pastDue: number; changing: number };
    // Ours: three active (99 + 99 + 49), one past due, two changing. Moving one out shows ours are counted.
    await prisma.paymentPlanSubscription.update({ where: { id: ids.active }, data: { status: "PAST_DUE" } });
    const after = (await list().expect(200)).body.summary as typeof before;
    await prisma.paymentPlanSubscription.update({ where: { id: ids.active }, data: { status: "ACTIVE" } });
    expect(before.active - after.active).to.equal(1);
    expect(Math.round((before.monthlyUsd - after.monthlyUsd) * 100) / 100).to.equal(99);
    expect(after.pastDue - before.pastDue).to.equal(1);
    expect(before.active).to.be.at.least(3);
    expect(before.changing).to.be.at.least(2);

    const page = (await request(app).get("/api/admin/lawyer-subscriptions?limit=1&page=1").set(auth(adminId)).expect(200)).body;
    expect(page).to.deep.include({ page: 1, pageSize: 1 });
    expect(page.data).to.have.length(1);
    expect(page.total).to.be.at.least(6);
  });
});
