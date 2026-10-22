/** /api/admin/billing (ilovelawyer-api#538): admin views of client app payments, and refunds. Runs
 * the real routes against the real database, like test/admin-llm-usage-route.spec.ts: it creates its
 * own clients, case and payments (every request is narrowed to them by `q`, a marker in their
 * emails, or by userId) and removes them afterwards. Stripe is replaced with a fake refunder, and the
 * security audit rows are captured in memory instead of written. */
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
import { setClientRefunder, type ClientRefundRequest, type ClientRefundResult } from "../src/payments/client-refunds";

const DAY = 24 * 60 * 60 * 1000;

describe("admin client billing routes", () => {
  const marker = `billing-spec-${crypto.randomUUID().slice(0, 8)}`;
  const adminId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const aliceId = crypto.randomUUID();
  const bobId = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  const now = Date.now();
  const ids = {
    stripeCase: crypto.randomUUID(),
    stripeTopUp: crypto.randomUUID(),
    dummyCase: crypto.randomUUID(),
    free: crypto.randomUUID(),
    failed: crypto.randomUUID(),
    pending: crypto.randomUUID(),
    old: crypto.randomUUID(),
  };
  const webhookEvents: string[] = [];

  const asUser = (id: string) => ({ Authorization: `Bearer ${loginToken(id, false).accessToken}` });
  const get = (path: string, as: string = adminId) => request(app).get(`/api/admin${path}`).set(asUser(as));
  const refund = (paymentId: string, body: object, as: string = adminId) =>
    request(app).post(`/api/admin/billing/${paymentId}/refund`).set(asUser(as)).send(body);

  const payment = (over: Record<string, unknown>) => ({
    userId: aliceId,
    caseId: null as string | null,
    kind: "CASE" as const,
    provider: "STRIPE",
    externalId: null as string | null,
    amountMinor: 999,
    currency: "USD",
    credits: 50,
    promoCode: null as string | null,
    status: "SUCCEEDED" as const,
    failureReason: null as string | null,
    ...over,
  });

  let refundRequests: ClientRefundRequest[];
  let refundAnswer: ClientRefundResult | Error;
  let auditRows: any[];
  let savedAuditCreate: unknown;

  before(async () => {
    await prisma.user.createMany({
      data: [
        { id: adminId, email: `adm-${adminId}@example.com`, username: `adm-${adminId}`, role: "ADMIN", name: "Ada Admin" },
        { id: memberId, email: `mem-${memberId}@example.com`, username: `mem-${memberId}` },
        { id: aliceId, email: `alice-${marker}@example.com`, username: `alice-${aliceId}`, name: "Alice Client" },
        { id: bobId, email: `bob-${marker}@example.com`, username: `bob-${bobId}`, name: "Bob Client" },
      ],
    });
    await prisma.case.create({ data: { id: caseId, userId: aliceId, caseName: "Unpaid wages", clientCredits: 40 } });
    await prisma.clientPayment.createMany({
      data: [
        payment({ id: ids.stripeCase, caseId, externalId: "cs_test_case", usedAt: new Date(now - 3 * DAY), createdAt: new Date(now - 3 * DAY) }),
        payment({ id: ids.stripeTopUp, caseId, kind: "TOP_UP", externalId: "cs_test_topup", amountMinor: 1500, credits: 25, createdAt: new Date(now - 2 * DAY) }),
        payment({ id: ids.dummyCase, userId: bobId, provider: "DUMMY", externalId: "dummy_1", createdAt: new Date(now - 2 * DAY) }),
        payment({ id: ids.free, userId: bobId, provider: "FREE", amountMinor: 0, promoCode: "FIRSTFREE", createdAt: new Date(now - 1 * DAY) }),
        payment({ id: ids.failed, provider: "DUMMY", status: "FAILED", failureReason: "Declined", createdAt: new Date(now - 1 * DAY) }),
        payment({ id: ids.pending, externalId: "cs_test_pending", status: "PENDING", createdAt: new Date(now - 1 * DAY) }),
        // Outside the default 30 days.
        payment({ id: ids.old, externalId: "cs_test_old", createdAt: new Date(now - 40 * DAY) }),
      ],
    });
  });

  after(async () => {
    await prisma.clientPayment.deleteMany({ where: { userId: { in: [aliceId, bobId] } } });
    await prisma.case.deleteMany({ where: { id: caseId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, memberId, aliceId, bobId] } } });
    await prisma.stripeWebhookEvent.deleteMany({ where: { id: { in: webhookEvents } } });
  });

  beforeEach(() => {
    refundRequests = [];
    refundAnswer = { externalId: "re_test_1", status: "SUCCEEDED", failureReason: null };
    setClientRefunder(async (req) => {
      refundRequests.push(req);
      if (refundAnswer instanceof Error) throw refundAnswer;
      return refundAnswer;
    });
    auditRows = [];
    savedAuditCreate = (SecurityAuditRepo as any).create;
    (SecurityAuditRepo as any).create = async (data: object) => {
      auditRows.push(data);
      return { id: "row", createdAt: new Date(), ...data };
    };
  });

  afterEach(async () => {
    setClientRefunder(null);
    (SecurityAuditRepo as any).create = savedAuditCreate;
    await prisma.clientRefund.deleteMany({ where: { payment: { userId: { in: [aliceId, bobId] } } } });
  });

  describe("access", () => {
    it("refuses a signed-out caller", async () => {
      await request(app).get("/api/admin/billing").expect(401);
      await request(app).get("/api/admin/billing/summary").expect(401);
      await request(app).post(`/api/admin/billing/${ids.stripeCase}/refund`).send({ reason: "x" }).expect(401);
    });

    it("refuses a signed-in non-admin with 403, and refunds nothing", async () => {
      await get(`/billing?q=${marker}`, memberId).expect(403);
      await get(`/billing/summary?q=${marker}`, memberId).expect(403);
      await get(`/billing/clients/${aliceId}`, memberId).expect(403);
      await refund(ids.stripeCase, { reason: "x" }, memberId).expect(403);
      expect(refundRequests).to.have.length(0);
    });
  });

  describe("GET /billing/summary", () => {
    it("totals what succeeded in the last 30 days, split by kind and provider, and counts every status", async () => {
      const { body } = await get(`/billing/summary?q=${marker}`).expect(200);
      // 999 Stripe case + 1500 Stripe top-up + 999 dummy case + 0 free
      expect(body.totals).to.deep.equal([
        { currency: "USD", paid: { amountMinor: 3498, currency: "USD" }, payments: 4, refunded: { amountMinor: 0, currency: "USD" }, refundPending: { amountMinor: 0, currency: "USD" }, net: { amountMinor: 3498, currency: "USD" } },
      ]);
      expect(body.counts).to.deep.equal({ PENDING: 1, SUCCEEDED: 4, FAILED: 1 });
      const byKind = Object.fromEntries(body.byKind.map((g: any) => [g.key, g.amount.amountMinor]));
      expect(byKind).to.deep.equal({ CASE: 1998, TOP_UP: 1500 });
      const byProvider = Object.fromEntries(body.byProvider.map((g: any) => [g.key, g.payments]));
      expect(byProvider).to.deep.equal({ STRIPE: 2, DUMMY: 1, FREE: 1 });
      expect(body.byDay.reduce((sum: number, d: any) => sum + d.amount.amountMinor, 0)).to.equal(3498);
      expect(body.byDay.map((d: any) => d.day)).to.deep.equal([...body.byDay.map((d: any) => d.day)].sort());
    });

    it("narrows by provider and by an explicit range", async () => {
      const stripe = await get(`/billing/summary?q=${marker}&provider=STRIPE`).expect(200);
      expect(stripe.body.totals[0].paid.amountMinor).to.equal(2499);
      const from = new Date(now - 45 * DAY).toISOString();
      const to = new Date(now - 35 * DAY).toISOString();
      const old = await get(`/billing/summary?q=${marker}&from=${from}&to=${to}`).expect(200);
      expect(old.body.totals[0].paid.amountMinor).to.equal(999);
      expect(old.body.range).to.deep.equal({ from, to });
    });

    it("refuses a range that ends before it starts", async () => {
      await get(`/billing/summary?from=${new Date(now).toISOString()}&to=${new Date(now - DAY).toISOString()}`).expect(400);
    });

    it("takes refunds off the net", async () => {
      await refund(ids.stripeTopUp, { amountMinor: 500, reason: "Credits didn't work" }).expect(200);
      const { body } = await get(`/billing/summary?q=${marker}`).expect(200);
      expect(body.totals[0].refunded.amountMinor).to.equal(500);
      expect(body.totals[0].net.amountMinor).to.equal(2998);
    });
  });

  describe("GET /billing", () => {
    it("lists newest first with the client, the case and what can be refunded", async () => {
      const { body } = await get(`/billing?q=${marker}`).expect(200);
      expect(body.total).to.equal(6);
      const times = body.rows.map((r: any) => new Date(r.createdAt).getTime());
      expect(times).to.deep.equal([...times].sort((a, b) => b - a));
      const topUp = body.rows.find((r: any) => r.id === ids.stripeTopUp);
      expect(topUp).to.deep.include({ kind: "TOP_UP", status: "SUCCEEDED", provider: "STRIPE", credits: 25 });
      expect(topUp.client).to.deep.equal({ id: aliceId, email: `alice-${marker}@example.com`, name: "Alice Client" });
      expect(topUp.case).to.deep.equal({ id: caseId, title: "Unpaid wages" });
      expect(topUp.refundable).to.deep.equal({ amountMinor: 1500, currency: "USD" });
      // Nothing to refund on fake or failed money.
      for (const id of [ids.dummyCase, ids.free, ids.failed, ids.pending]) {
        expect(body.rows.find((r: any) => r.id === id).refundable.amountMinor, id).to.equal(0);
      }
    });

    it("filters by status, kind, provider, client and case, and pages", async () => {
      const ofIds = async (query: string) => (await get(`/billing?q=${marker}&${query}`).expect(200)).body.rows.map((r: any) => r.id).sort();
      expect(await ofIds("status=PENDING")).to.deep.equal([ids.pending]);
      expect(await ofIds("kind=TOP_UP")).to.deep.equal([ids.stripeTopUp]);
      expect(await ofIds("provider=DUMMY")).to.deep.equal([ids.dummyCase, ids.failed].sort());
      expect(await ofIds(`userId=${bobId}`)).to.deep.equal([ids.dummyCase, ids.free].sort());
      expect(await ofIds(`caseId=${caseId}`)).to.deep.equal([ids.stripeCase, ids.stripeTopUp].sort());
      const page2 = await get(`/billing?q=${marker}&limit=4&page=2`).expect(200);
      expect(page2.body).to.deep.include({ total: 6, page: 2, pageSize: 4, totalPages: 2 });
      expect(page2.body.rows).to.have.length(2);
    });

    it("finds a client by name as well as email, in any case", async () => {
      const { body } = await get(`/billing?q=${marker}&userId=${bobId}`).expect(200);
      expect(body.total).to.equal(2);
      const byName = await get(`/billing?q=BOB%20CLIENT&userId=${bobId}`).expect(200);
      expect(byName.body.total).to.equal(2);
    });

    it("rejects an unknown filter value", async () => {
      await get("/billing?provider=PAYPAL").expect(400);
      await get("/billing?limit=1000").expect(400);
    });
  });

  describe("GET /billing/clients/:userId", () => {
    it("shows one client's totals, cases and payments, all time", async () => {
      const { body } = await get(`/billing/clients/${aliceId}`).expect(200);
      expect(body.user).to.deep.include({ id: aliceId, email: `alice-${marker}@example.com`, name: "Alice Client" });
      // All time: the 40-day-old payment counts here.
      expect(body.totals[0].paid.amountMinor).to.equal(999 + 1500 + 999);
      expect(body.counts).to.deep.equal({ PENDING: 1, SUCCEEDED: 3, FAILED: 1 });
      expect(body.cases).to.deep.equal([{ id: caseId, title: "Unpaid wages", credits: 40, createdAt: body.cases[0].createdAt }]);
      expect(body.payments.total).to.equal(5);
    });

    it("404s for an unknown user", async () => {
      await get(`/billing/clients/${crypto.randomUUID()}`).expect(404);
    });
  });

  describe("POST /billing/:id/refund", () => {
    it("refunds in full through Stripe when no amount is given, and audits it", async () => {
      const { body } = await refund(ids.stripeCase, { reason: "Client asked within 14 days" }).expect(200);
      expect(refundRequests).to.have.length(1);
      expect(refundRequests[0]).to.deep.include({ paymentId: ids.stripeCase, checkoutSessionId: "cs_test_case", amountMinor: 999 });
      expect(body.refunded).to.deep.equal({ amountMinor: 999, currency: "USD" });
      expect(body.refundable.amountMinor).to.equal(0);
      expect(body.refunds).to.have.length(1);
      expect(body.refunds[0]).to.deep.include({ status: "SUCCEEDED", externalId: "re_test_1", reason: "Client asked within 14 days" });
      expect(body.refunds[0].admin).to.deep.equal({ id: adminId, name: "Ada Admin" });

      expect(auditRows).to.have.length(1);
      expect(auditRows[0]).to.deep.include({ action: "admin.client_payment.refunded", outcome: "SUCCESS", actorId: adminId, targetType: "user", targetId: aliceId, caseId });
      expect(auditRows[0].payload).to.deep.include({ paymentId: ids.stripeCase, refundId: body.refunds[0].id, amountMinor: 999, currency: "USD", status: "SUCCEEDED", reason: "Client asked within 14 days" });
    });

    it("keeps the case and its credits", async () => {
      await refund(ids.stripeTopUp, { reason: "Goodwill" }).expect(200);
      const row = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(row.clientCredits).to.equal(40);
    });

    it("refunds part, then the rest, and refuses more than what's left", async () => {
      await refund(ids.stripeTopUp, { amountMinor: 1000, reason: "Partial" }).expect(200);
      const tooMuch = await refund(ids.stripeTopUp, { amountMinor: 501, reason: "Too much" }).expect(400);
      expect(tooMuch.body.code ?? tooMuch.body.error?.code).to.equal("REFUND_EXCEEDS_PAYMENT");
      const { body } = await refund(ids.stripeTopUp, { reason: "The rest" }).expect(200);
      expect(refundRequests.map((r) => r.amountMinor)).to.deep.equal([1000, 500]);
      expect(body.refunded.amountMinor).to.equal(1500);
      const again = await refund(ids.stripeTopUp, { reason: "Again" }).expect(409);
      expect(JSON.stringify(again.body)).to.contain("ALREADY_REFUNDED");
    });

    it("never refunds more than was paid when two admins refund at once", async () => {
      const results = await Promise.all([1, 2, 3].map(() => refund(ids.stripeTopUp, { amountMinor: 600, reason: "Race" })));
      const ok = results.filter((r) => r.status === 200);
      expect(ok).to.have.length(2);
      const held = await prisma.clientRefund.aggregate({ where: { paymentId: ids.stripeTopUp, status: { in: ["PENDING", "SUCCEEDED"] } }, _sum: { amountMinor: true } });
      expect(held._sum.amountMinor).to.equal(1200);
    });

    it("refuses a dummy payment clearly, without calling Stripe", async () => {
      const res = await refund(ids.dummyCase, { reason: "Test" }).expect(409);
      expect(JSON.stringify(res.body)).to.contain("REFUND_NOT_SUPPORTED");
      expect(JSON.stringify(res.body)).to.contain("dummy provider");
      expect(refundRequests).to.have.length(0);
    });

    it("refuses a free, failed or pending payment", async () => {
      await refund(ids.free, { reason: "Test" }).expect(409);
      await refund(ids.failed, { reason: "Test" }).expect(409);
      const pending = await refund(ids.pending, { reason: "Test" }).expect(409);
      expect(JSON.stringify(pending.body)).to.contain("PAYMENT_NOT_REFUNDABLE");
      expect(refundRequests).to.have.length(0);
    });

    it("needs a reason, and a whole positive amount", async () => {
      await refund(ids.stripeCase, {}).expect(400);
      await refund(ids.stripeCase, { reason: "  " }).expect(400);
      await refund(ids.stripeCase, { reason: "x", amountMinor: 0 }).expect(400);
      await refund(ids.stripeCase, { reason: "x", amountMinor: 1.5 }).expect(400);
      await refund(crypto.randomUUID(), { reason: "x" }).expect(404);
    });

    it("marks the refund FAILED, frees the amount and audits a failure when Stripe refuses", async () => {
      refundAnswer = new Error("Charge ch_1 has already been refunded.");
      const res = await refund(ids.stripeCase, { reason: "Try" }).expect(502);
      expect(JSON.stringify(res.body)).to.contain("already been refunded");
      const row = await prisma.clientRefund.findFirstOrThrow({ where: { paymentId: ids.stripeCase } });
      expect(row).to.deep.include({ status: "FAILED", failureReason: "Charge ch_1 has already been refunded." });
      expect(auditRows[0]).to.deep.include({ action: "admin.client_payment.refunded", outcome: "FAILURE" });

      refundAnswer = { externalId: "re_test_2", status: "SUCCEEDED", failureReason: null };
      await refund(ids.stripeCase, { reason: "Retry" }).expect(200);
    });

    it("keeps a refund Stripe hasn't finished PENDING until its webhook settles it", async () => {
      refundAnswer = { externalId: "re_test_slow", status: "PENDING", failureReason: null };
      const { body } = await refund(ids.stripeCase, { reason: "Slow bank" }).expect(200);
      expect(body.refundPending.amountMinor).to.equal(999);
      expect(body.refundable.amountMinor).to.equal(0);

      const eventId = `evt_${crypto.randomUUID()}`;
      webhookEvents.push(eventId);
      const event = {
        id: eventId,
        type: "refund.updated",
        data: { object: { id: "re_test_slow", status: "succeeded", failure_reason: null, metadata: { refundId: body.refunds[0].id } } },
      } as unknown as Stripe.Event;
      await ClientBillingSvc.handleStripeEvent(event);
      const after = await get(`/billing/${ids.stripeCase}`).expect(200);
      expect(after.body.refunds[0].status).to.equal("SUCCEEDED");
      expect(after.body.refunded.amountMinor).to.equal(999);
    });

    it("gives the amount back when Stripe's webhook says the refund failed", async () => {
      refundAnswer = { externalId: "re_test_fails", status: "PENDING", failureReason: null };
      await refund(ids.stripeCase, { reason: "Will fail" }).expect(200);
      const eventId = `evt_${crypto.randomUUID()}`;
      webhookEvents.push(eventId);
      await ClientBillingSvc.handleStripeEvent({
        id: eventId,
        type: "refund.failed",
        data: { object: { id: "re_test_fails", status: "failed", failure_reason: "expired_or_canceled_card", metadata: {} } },
      } as unknown as Stripe.Event);
      const { body } = await get(`/billing/${ids.stripeCase}`).expect(200);
      expect(body.refunds[0]).to.deep.include({ status: "FAILED", failureReason: "expired_or_canceled_card" });
      expect(body.refundable.amountMinor).to.equal(999);
    });
  });
});
