/** /api/admin/client-requests, /fees-summary and /api/admin/charges/:id/refund (#520): platform admins'
 * view of the client hand-off and refunds of the firms' charges. Real routes against the real
 * database, with their own firms, lawyers, client, case and requests (every list is narrowed to the
 * case, every summary to 2020, when only this spec's charges were made). Stripe is a fake provider;
 * the security audit rows are captured in memory. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import request from "supertest";
import type Stripe from "stripe";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import loginToken from "../src/utils/loginToken";
import SecurityAuditRepo from "../src/repositories/security-audit.repository";
import ClientBillingSvc from "../src/services/client-billing.service";
import { setOrganizationCardProvider, ORGANIZATION_REFUND_PURPOSE, type ChargeRefundRequest, type HostedOrganizationCardProvider } from "../src/payments/organization-card-provider";
import type { ClientRefundResult } from "../src/payments/client-refunds";

const HOUR_MS = 60 * 60 * 1000;
const IN_2020 = (day: number) => new Date(Date.UTC(2020, 0, day, 12));

describe("admin client requests, fees and refunds", () => {
  const adminId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  const lawyer1 = crypto.randomUUID();
  const lawyer2 = crypto.randomUUID();
  const org1 = crypto.randomUUID();
  const org2 = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  const ids = { stale: crypto.randomUUID(), fresh: crypto.randomUUID(), engaged: crypto.randomUUID(), dummy: crypto.randomUUID(), failed: crypto.randomUUID() };
  const charges = { stripe: crypto.randomUUID(), dummy: crypto.randomUUID(), failed: crypto.randomUUID() };
  const webhookEvents: string[] = [];

  let refundRequests: ChargeRefundRequest[];
  let refundAnswer: ClientRefundResult | Error;
  let auditRows: any[];
  let savedAuditCreate: unknown;

  const fakeStripe: HostedOrganizationCardProvider = {
    name: "STRIPE",
    mode: "hosted",
    async startSetup() {
      throw new Error("not used");
    },
    async completedSetup() {
      return null;
    },
    async makeDefault() {},
    async charge() {
      throw new Error("not used");
    },
    async chargeStatus() {
      throw new Error("not used");
    },
    async refund(req) {
      refundRequests.push(req);
      if (refundAnswer instanceof Error) throw refundAnswer;
      return refundAnswer;
    },
  };

  const auth = (id: string) => ({ Authorization: `Bearer ${loginToken(id, false).accessToken}` });
  const get = (path: string, as = adminId) => request(app).get(`/api/admin${path}`).set(auth(as));
  const refund = (chargeId: string, body: object, as = adminId) => request(app).post(`/api/admin/charges/${chargeId}/refund`).set(auth(as)).send(body);
  const list = (query = "") => get(`/client-requests?caseId=${caseId}${query}`);
  const summary = (query = "") => get(`/client-requests/fees-summary?from=2020-01-01&to=2020-12-31${query}`);

  before(async () => {
    const tenant = await prisma.tenant.upsert({ where: { code: "UK" }, update: {}, create: { code: "UK", name: "United Kingdom" } });
    const user = (id: string, name: string, role: "ADMIN" | "LAWYER" | "USER") => ({ id, email: `adm-req-${id}@example.com`, username: `adm-req-${id}`, name, role, tenantId: tenant.id });
    await prisma.user.createMany({
      data: [user(adminId, "Ada Admin", "ADMIN"), user(memberId, "Mo NotAdmin", "USER"), user(clientId, "Clara Client", "USER"), user(lawyer1, "Lena One", "LAWYER"), user(lawyer2, "Liam Two", "LAWYER")],
    });
    for (const [id, owner, name] of [
      [org1, lawyer1, "One Law LLP"],
      [org2, lawyer2, "Two Law LLP"],
    ] as const) {
      await prisma.organization.create({ data: { id, name, slug: `adm-req-${id}`, tenantId: tenant.id, createdById: owner, members: { create: { userId: owner, role: "OWNER", status: "ACCEPTED" } } } });
    }
    await prisma.case.create({ data: { id: caseId, userId: clientId, caseName: "Dismissal", practiceArea: "EMPLOYMENT", ukJurisdiction: "England and Wales" } });

    const now = Date.now();
    const req = (id: string, status: any, hoursOld: number, extra: object = {}) => ({
      id,
      caseId,
      clientId,
      status,
      consentVersion: "test",
      consentAcceptedAt: new Date(now - hoursOld * HOUR_MS),
      createdAt: new Date(now - hoursOld * HOUR_MS),
      routedAt: new Date(now - hoursOld * HOUR_MS),
      routingExpiresAt: new Date(now - hoursOld * HOUR_MS + 48 * HOUR_MS),
      ...extra,
    });
    await prisma.clientRequest.createMany({
      data: [
        req(ids.stale, "ROUTED", 72),
        req(ids.fresh, "ROUTED", 1),
        req(ids.engaged, "ENGAGED", 30, { engagedAt: new Date(now - 2 * HOUR_MS) }),
        req(ids.dummy, "ENGAGED", 40, { engagedAt: new Date(now - 3 * HOUR_MS) }),
        req(ids.failed, "CONFIRMED", 20),
      ],
    });
    const claim = (requestId: string, lawyerId: string, organizationId: string, outcome: any) => ({
      requestId,
      lawyerId,
      organizationId,
      claimedAt: new Date(now - 10 * HOUR_MS),
      expiresAt: new Date(now + 14 * HOUR_MS),
      outcome,
      quoteType: "FIXED_FEE" as const,
      quoteAmountMinor: 90000,
      quoteCurrency: "GBP",
      quotedAt: new Date(now - 9 * HOUR_MS),
    });
    await prisma.clientRequestClaim.createMany({
      data: [claim(ids.engaged, lawyer1, org1, "ENGAGED"), claim(ids.dummy, lawyer2, org2, "ENGAGED"), { ...claim(ids.failed, lawyer1, org1, null), openRequestId: ids.failed }],
    });
    const charge = (id: string, requestId: string, organizationId: string, lawyerId: string, provider: string, status: any, day: number) => ({
      id,
      organizationId,
      kind: "PER_CASE_FEE" as const,
      status,
      amountMinor: 5000,
      currency: "GBP",
      provider,
      requestId,
      feeRequestId: requestId,
      lawyerId,
      paymentIntentId: provider === "STRIPE" ? `pi_${id}` : `dummy_pi_${id}`,
      attempts: 1,
      createdAt: IN_2020(day),
    });
    await prisma.organizationCharge.createMany({
      data: [
        charge(charges.stripe, ids.engaged, org1, lawyer1, "STRIPE", "SUCCEEDED", 5),
        charge(charges.dummy, ids.dummy, org2, lawyer2, "DUMMY", "SUCCEEDED", 6),
        { ...charge(charges.failed, ids.failed, org1, lawyer1, "STRIPE", "FAILED", 7), failureReason: "Your card was declined." },
      ],
    });
  });

  after(async () => {
    await prisma.organizationCharge.deleteMany({ where: { organizationId: { in: [org1, org2] } } });
    await prisma.clientRequest.deleteMany({ where: { caseId } });
    await prisma.case.deleteMany({ where: { id: caseId } });
    await prisma.organizationMember.deleteMany({ where: { organizationId: { in: [org1, org2] } } });
    await prisma.organization.deleteMany({ where: { OR: [{ id: { in: [org1, org2] } }, { createdById: { in: [clientId, memberId] } }] } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, memberId, clientId, lawyer1, lawyer2] } } });
    await prisma.stripeWebhookEvent.deleteMany({ where: { id: { in: webhookEvents } } });
  });

  beforeEach(() => {
    refundRequests = [];
    refundAnswer = { externalId: "re_test_1", status: "SUCCEEDED", failureReason: null };
    setOrganizationCardProvider(fakeStripe);
    auditRows = [];
    savedAuditCreate = (SecurityAuditRepo as any).create;
    (SecurityAuditRepo as any).create = async (data: object) => {
      auditRows.push(data);
      return { id: "row", createdAt: new Date(), ...data };
    };
  });

  afterEach(async () => {
    setOrganizationCardProvider(null);
    (SecurityAuditRepo as any).create = savedAuditCreate;
    await prisma.organizationChargeRefund.deleteMany({ where: { chargeId: { in: Object.values(charges) } } });
    await prisma.organizationCharge.updateMany({ where: { id: { in: [charges.stripe, charges.dummy] } }, data: { status: "SUCCEEDED" } });
  });

  describe("access", () => {
    it("is for platform admins only", async () => {
      await request(app).get("/api/admin/client-requests").expect(401);
      await get("/client-requests", memberId).expect(403);
      await get("/client-requests/fees-summary", memberId).expect(403);
      await refund(charges.stripe, { reason: "x" }, memberId).expect(403);
      expect(refundRequests).to.have.length(0);
    });
  });

  describe("GET /client-requests", () => {
    it("lists every request, newest first, with its claims, firm and charges", async () => {
      const { body } = await list().expect(200);
      expect(body.total).to.equal(5);
      expect(body.data.map((r: any) => r.id)).to.deep.equal([ids.fresh, ids.failed, ids.engaged, ids.dummy, ids.stale]);
      const engaged = body.data.find((r: any) => r.id === ids.engaged);
      expect(engaged).to.deep.include({ status: "ENGAGED", practiceArea: "EMPLOYMENT", ukJurisdiction: "England and Wales", organizationName: "One Law LLP", unclaimedOver48h: false });
      expect(engaged.ageHours).to.be.closeTo(30, 0.2);
      expect(engaged.claims[0]).to.deep.include({ lawyerId: lawyer1, lawyerName: "Lena One", organizationName: "One Law LLP", outcome: "ENGAGED" });
      expect(engaged.claims[0].quote).to.deep.include({ type: "FIXED_FEE", amount: { amountMinor: 90000, currency: "GBP" } });
      expect(engaged.charges[0]).to.deep.include({ id: charges.stripe, status: "SUCCEEDED", provider: "STRIPE", refundable: { amountMinor: 5000, currency: "GBP" } });
      expect(engaged.charges[0].lawyer).to.deep.equal({ id: lawyer1, name: "Lena One" });
      // Nothing to give back on a test card or a failed charge.
      expect(body.data.find((r: any) => r.id === ids.dummy).charges[0].refundable.amountMinor).to.equal(0);
      expect(body.data.find((r: any) => r.id === ids.failed).charges[0]).to.deep.include({ status: "FAILED", failureReason: "Your card was declined." });
      expect(body.data.find((r: any) => r.id === ids.fresh).matchedLawyers).to.be.a("number");
    });

    it("filters by status, age, and requests nobody claimed within 48h", async () => {
      const idsOf = async (q: string) => (await list(q).expect(200)).body.data.map((r: any) => r.id).sort();
      expect(await idsOf("&status=ENGAGED")).to.deep.equal([ids.engaged, ids.dummy].sort());
      expect(await idsOf("&minAgeHours=35")).to.deep.equal([ids.dummy, ids.stale].sort());
      expect(await idsOf("&unclaimedOver48h=true")).to.deep.equal([ids.stale]);
      expect((await list("&unclaimedOver48h=true").expect(200)).body.data[0].unclaimedOver48h).to.equal(true);
      await list("&status=NOPE").expect(400);
    });
  });

  describe("GET /client-requests/fees-summary", () => {
    it("totals paid fees per organization, leaving out failed charges", async () => {
      const { body } = await summary().expect(200);
      const byId = Object.fromEntries(body.map((r: any) => [r.id, r]));
      expect(byId[org1]).to.deep.equal({ id: org1, name: "One Law LLP", engagements: 1, perCaseFees: { amountMinor: 5000, currency: "GBP" }, topUps: { amountMinor: 0, currency: "GBP" }, refunds: { amountMinor: 0, currency: "GBP" } });
      expect(byId[org2]).to.deep.include({ name: "Two Law LLP", engagements: 1 });
    });

    it("groups by lawyer, narrows by date, and shows refunds", async () => {
      await refund(charges.stripe, { amount: { amountMinor: 2000, currency: "GBP" }, reason: "Goodwill" }).expect(200);
      const { body } = await summary("&groupBy=lawyer").expect(200);
      const lena = body.find((r: any) => r.id === lawyer1);
      expect(lena).to.deep.include({ name: "Lena One", engagements: 1, refunds: { amountMinor: 2000, currency: "GBP" } });
      // Only charges up to and including 5 January.
      const early = await get("/client-requests/fees-summary?from=2020-01-01&to=2020-01-05").expect(200);
      expect(early.body.map((r: any) => r.id)).to.deep.equal([org1]);
      await get("/client-requests/fees-summary?from=2020-02-01&to=2020-01-01").expect(400);
    });
  });

  describe("POST /charges/:id/refund", () => {
    it("refunds in full through Stripe, marks the charge REFUNDED, and audits it in the firm's log", async () => {
      const { body } = await refund(charges.stripe, { reason: "Client never engaged" }).expect(200);
      expect(refundRequests).to.deep.equal([{ refundId: body.refunds[0].id, chargeId: charges.stripe, paymentIntentId: `pi_${charges.stripe}`, amountMinor: 5000 }]);
      expect(body).to.deep.include({ status: "REFUNDED", refunded: { amountMinor: 5000, currency: "GBP" }, refundable: { amountMinor: 0, currency: "GBP" } });
      expect(body.refunds[0]).to.deep.include({ status: "SUCCEEDED", externalId: "re_test_1", reason: "Client never engaged" });
      expect(body.refunds[0].admin).to.deep.equal({ id: adminId, name: "Ada Admin" });

      expect(auditRows).to.have.length(1);
      expect(auditRows[0]).to.deep.include({ action: "admin.organization_charge.refunded", outcome: "SUCCESS", actorId: adminId, organizationId: org1, targetType: "organization", targetId: org1 });
      expect(auditRows[0].payload).to.deep.include({ chargeId: charges.stripe, kind: "PER_CASE_FEE", amountMinor: 5000, currency: "GBP", reason: "Client never engaged", status: "SUCCEEDED" });
      // The engagement it paid for carries on.
      expect((await prisma.clientRequest.findUniqueOrThrow({ where: { id: ids.engaged } })).status).to.equal("ENGAGED");
    });

    it("refunds part, then the rest, and refuses more than what's left", async () => {
      expect((await refund(charges.stripe, { amount: { amountMinor: 3000, currency: "GBP" }, reason: "Part" }).expect(200)).body.status).to.equal("PARTIALLY_REFUNDED");
      const tooMuch = await refund(charges.stripe, { amount: { amountMinor: 2001, currency: "GBP" }, reason: "Too much" }).expect(400);
      expect(tooMuch.body.code).to.equal("REFUND_EXCEEDS_CHARGE");
      expect((await refund(charges.stripe, { reason: "The rest" }).expect(200)).body.status).to.equal("REFUNDED");
      expect(refundRequests.map((r) => r.amountMinor)).to.deep.equal([3000, 2000]);
      expect((await refund(charges.stripe, { reason: "Again" }).expect(409)).body.code).to.equal("ALREADY_REFUNDED");
    });

    it("never refunds more than was paid when admins refund at once", async () => {
      const results = await Promise.all([1, 2, 3].map(() => refund(charges.stripe, { amount: { amountMinor: 2000, currency: "GBP" }, reason: "Race" })));
      expect(results.filter((r) => r.status === 200)).to.have.length(2);
      const held = await prisma.organizationChargeRefund.aggregate({ where: { chargeId: charges.stripe, status: { in: ["PENDING", "SUCCEEDED"] } }, _sum: { amountMinor: true } });
      expect(held._sum.amountMinor).to.equal(4000);
    });

    it("refuses a test card's charge and a failed one, without calling Stripe", async () => {
      expect((await refund(charges.dummy, { reason: "x" }).expect(409)).body.code).to.equal("REFUND_NOT_SUPPORTED");
      expect((await refund(charges.failed, { reason: "x" }).expect(409)).body.code).to.equal("CHARGE_NOT_REFUNDABLE");
      expect(refundRequests).to.have.length(0);
    });

    it("needs a reason and a whole positive GBP amount", async () => {
      await refund(charges.stripe, {}).expect(400);
      await refund(charges.stripe, { reason: "  " }).expect(400);
      await refund(charges.stripe, { reason: "x", amount: { amountMinor: 0, currency: "GBP" } }).expect(400);
      await refund(charges.stripe, { reason: "x", amount: { amountMinor: 10, currency: "USD" } }).expect(400);
      await refund(crypto.randomUUID(), { reason: "x" }).expect(404);
    });

    it("marks the refund FAILED, frees the amount and audits a failure when Stripe refuses", async () => {
      refundAnswer = new Error("Charge has already been refunded.");
      const res = await refund(charges.stripe, { reason: "Try" }).expect(502);
      expect(res.body.code).to.equal("PAYMENT_PROVIDER_ERROR");
      expect(await prisma.organizationChargeRefund.findFirstOrThrow({ where: { chargeId: charges.stripe } })).to.deep.include({ status: "FAILED" });
      expect(auditRows[0]).to.deep.include({ action: "admin.organization_charge.refunded", outcome: "FAILURE" });
      refundAnswer = { externalId: "re_test_2", status: "SUCCEEDED", failureReason: null };
      expect((await refund(charges.stripe, { reason: "Retry" }).expect(200)).body.status).to.equal("REFUNDED");
    });

    it("keeps a refund Stripe hasn't finished PENDING until its webhook, and only then marks the charge", async () => {
      refundAnswer = { externalId: "re_slow", status: "PENDING", failureReason: null };
      const { body } = await refund(charges.stripe, { reason: "Slow" }).expect(200);
      expect(body).to.deep.include({ status: "SUCCEEDED", refundPending: { amountMinor: 5000, currency: "GBP" }, refundable: { amountMinor: 0, currency: "GBP" } });

      const id = `evt_${crypto.randomUUID()}`;
      webhookEvents.push(id);
      await ClientBillingSvc.handleStripeEvent({
        id,
        type: "refund.updated",
        data: { object: { id: "re_slow", status: "succeeded", failure_reason: null, metadata: { purpose: ORGANIZATION_REFUND_PURPOSE, refundId: body.refunds[0].id } } },
      } as unknown as Stripe.Event);
      const after = (await get(`/charges/${charges.stripe}`).expect(200)).body;
      expect(after).to.deep.include({ status: "REFUNDED", refunded: { amountMinor: 5000, currency: "GBP" } });
      expect(after.refunds[0].status).to.equal("SUCCEEDED");
    });
  });
});
