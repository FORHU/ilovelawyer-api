/** The client confirms or declines the quote, and the lawyer's organization is charged the per-case
 * fee (#513): POST /client/lawyer-requests/:id/confirm and /decline, POST /client-requests/:id/charge/
 * retry, the Stripe webhook settling a charge later, and GET /organizations/:id/billing/fees. Through
 * the real routes against the real database, with its own UK firm, lawyer, client, case and request.
 * Stripe is a fake provider whose answers each test sets. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import request from "supertest";
import type Stripe from "stripe";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import loginToken from "../src/utils/loginToken";
import ClientBillingSvc from "../src/services/client-billing.service";
import {
  setOrganizationCardProvider,
  ORGANIZATION_CHARGE_PURPOSE,
  type CardChargeRequest,
  type CardChargeResult,
  type HostedOrganizationCardProvider,
} from "../src/payments/organization-card-provider";
import { CLIENT_REQUEST_PER_CASE_FEE_MINOR } from "../src/constants/client-request.constants";

const HOUR_MS = 60 * 60 * 1000;

describe("client confirms, the firm is charged the per-case fee", () => {
  const lawyerId = crypto.randomUUID();
  const adminId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const otherLawyerId = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const otherOrgId = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  const webhookEvents: string[] = [];
  let requestId: string;
  let claimId: string;

  // The fake Stripe: each charge's answer, in order (an Error means Stripe couldn't be reached).
  let answers: (CardChargeResult | Error)[];
  let chargeRequests: CardChargeRequest[];
  let stripeNow: Map<string, CardChargeResult>;

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
    async charge(req) {
      chargeRequests.push(req);
      const next = answers.shift() ?? { status: "SUCCEEDED", paymentIntentId: `pi_${chargeRequests.length}`, receiptUrl: "https://pay.stripe.com/receipts/x", failureReason: null };
      if (next instanceof Error) throw next;
      return next;
    },
    async chargeStatus(paymentIntentId) {
      return stripeNow.get(paymentIntentId) ?? { status: "PENDING", paymentIntentId, receiptUrl: null, failureReason: null };
    },
    // Refunds are #520's, tested in admin-client-requests-route.spec.ts.
    async refund() {
      throw new Error("not used");
    },
  };
  const ok = (pi: string): CardChargeResult => ({ status: "SUCCEEDED", paymentIntentId: pi, receiptUrl: `https://pay.stripe.com/receipts/${pi}`, failureReason: null });
  const declined = (pi: string): CardChargeResult => ({ status: "FAILED", paymentIntentId: pi, receiptUrl: null, failureReason: "Your card was declined." });
  const processing = (pi: string): CardChargeResult => ({ status: "PENDING", paymentIntentId: pi, receiptUrl: null, failureReason: null });

  const auth = (id: string) => ({ Authorization: `Bearer ${loginToken(id, false).accessToken}` });
  const confirm = (body: object = { disclosureAcknowledged: true }) => request(app).post(`/api/client/lawyer-requests/${requestId}/confirm`).set(auth(clientId)).send(body);
  const decline = (body: object = {}) => request(app).post(`/api/client/lawyer-requests/${requestId}/decline`).set(auth(clientId)).send(body);
  const clientView = () => request(app).get(`/api/client/lawyer-requests/${requestId}`).set(auth(clientId));
  const retry = (id = lawyerId, org = orgId) => request(app).post(`/api/client-requests/${requestId}/charge/retry`).set({ ...auth(id), "X-Organization-Id": org });
  const lawyerView = () => request(app).get(`/api/client-requests/${requestId}`).set({ ...auth(lawyerId), "X-Organization-Id": orgId });
  const fees = (as = lawyerId) => request(app).get(`/api/organizations/${orgId}/billing/fees`).set(auth(as));

  const card = (provider: "STRIPE" | "DUMMY") =>
    prisma.organizationBilling.upsert({
      where: { organizationId: orgId },
      create: { organizationId: orgId, provider, customerId: provider === "STRIPE" ? "cus_test_firm" : null, paymentMethodId: `${provider.toLowerCase()}_pm_1`, brand: "visa", last4: "4242" },
      update: { provider, customerId: provider === "STRIPE" ? "cus_test_firm" : null, paymentMethodId: `${provider.toLowerCase()}_pm_1` },
    });
  const state = async () => {
    const row = await prisma.clientRequest.findUniqueOrThrow({ where: { id: requestId }, include: { claims: true, charges: true } });
    return { status: row.status, engagedAt: row.engagedAt, claim: row.claims[0]!, charges: row.charges };
  };
  const webhook = async (type: string, pi: string, chargeId: string) => {
    const id = `evt_${crypto.randomUUID()}`;
    webhookEvents.push(id);
    await ClientBillingSvc.handleStripeEvent({
      id,
      type,
      data: { object: { id: pi, metadata: { purpose: ORGANIZATION_CHARGE_PURPOSE, chargeId } } },
    } as unknown as Stripe.Event);
  };
  const notificationsFor = (userId: string) => prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });

  before(async () => {
    const tenant = await prisma.tenant.upsert({ where: { code: "UK" }, update: {}, create: { code: "UK", name: "United Kingdom" } });
    const user = (id: string, name: string, role: "LAWYER" | "USER") => ({ id, email: `confirm-${id}@example.com`, username: `confirm-${id}`, name, role, tenantId: tenant.id });
    await prisma.user.createMany({
      data: [
        user(lawyerId, "Lena Lawyer", "LAWYER"),
        user(adminId, "Ada FirmAdmin", "LAWYER"),
        user(memberId, "Mo Member", "LAWYER"),
        user(otherLawyerId, "Omar Other", "LAWYER"),
        user(clientId, "Clara Client", "USER"),
      ],
    });
    await prisma.organization.create({
      data: {
        id: orgId,
        name: "Lena Law LLP",
        slug: `confirm-${orgId}`,
        tenantId: tenant.id,
        createdById: lawyerId,
        members: {
          create: [
            { userId: lawyerId, role: "OWNER", status: "ACCEPTED" },
            { userId: adminId, role: "ADMIN", status: "ACCEPTED" },
            { userId: memberId, role: "MEMBER", status: "ACCEPTED" },
          ],
        },
      },
    });
    await prisma.organization.create({
      data: { id: otherOrgId, name: "Other Firm", slug: `confirm-${otherOrgId}`, tenantId: tenant.id, createdById: otherLawyerId, members: { create: { userId: otherLawyerId, role: "OWNER", status: "ACCEPTED" } } },
    });
    const profile = { practiceAreas: ["EMPLOYMENT"], acceptingRequests: true, verificationStatus: "VERIFIED" as const, verifiedAt: new Date() };
    await prisma.lawyerClientProfile.createMany({ data: [{ ...profile, userId: lawyerId }, { ...profile, userId: otherLawyerId }] });
    const registration = { regulator: "SRA", qualifiedJurisdictions: ["England and Wales"] };
    await prisma.lawyerUkRegistration.createMany({ data: [{ ...registration, userId: lawyerId, registrationNumber: "111" }, { ...registration, userId: otherLawyerId, registrationNumber: "222" }] });
    await prisma.case.create({ data: { id: caseId, userId: clientId, caseName: "Unfair dismissal", practiceArea: "EMPLOYMENT", ukJurisdiction: "England and Wales" } });
  });

  after(async () => {
    await prisma.organizationCharge.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId] } } });
    await prisma.clientRequest.deleteMany({ where: { caseId } });
    await prisma.auditEvent.deleteMany({ where: { caseId } });
    await prisma.notification.deleteMany({ where: { userId: { in: [lawyerId, adminId, memberId, otherLawyerId, clientId] } } });
    await prisma.case.deleteMany({ where: { id: caseId } });
    await prisma.organizationBilling.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId] } } });
    await prisma.lawyerClientProfile.deleteMany({ where: { userId: { in: [lawyerId, otherLawyerId] } } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: [lawyerId, adminId, memberId, otherLawyerId, clientId] } } });
    await prisma.organization.deleteMany({ where: { OR: [{ id: { in: [orgId, otherOrgId] } }, { createdById: clientId }] } });
    await prisma.user.deleteMany({ where: { id: { in: [lawyerId, adminId, memberId, otherLawyerId, clientId] } } });
    await prisma.stripeWebhookEvent.deleteMany({ where: { id: { in: webhookEvents } } });
  });

  beforeEach(async () => {
    answers = [];
    chargeRequests = [];
    stripeNow = new Map();
    setOrganizationCardProvider(fakeStripe);
    await prisma.organizationCharge.deleteMany({ where: { organizationId: orgId } });
    await prisma.clientRequest.deleteMany({ where: { caseId } });
    await prisma.organizationBilling.deleteMany({ where: { organizationId: orgId } });
    await prisma.notification.deleteMany({ where: { userId: { in: [lawyerId, adminId, memberId] } } });
    // A request the lawyer has claimed and quoted on.
    const now = new Date();
    const row = await prisma.clientRequest.create({
      data: { caseId, clientId, consentVersion: "test", consentAcceptedAt: now, status: "QUOTED", routedAt: now, routingExpiresAt: new Date(now.getTime() + 48 * HOUR_MS) },
    });
    requestId = row.id;
    const claim = await prisma.clientRequestClaim.create({
      data: {
        requestId,
        openRequestId: requestId,
        lawyerId,
        organizationId: orgId,
        claimedAt: now,
        expiresAt: new Date(now.getTime() + 24 * HOUR_MS),
        quoteType: "FIXED_FEE",
        quoteAmountMinor: 75000,
        quoteCurrency: "GBP",
        quoteMessage: "Fixed fee.",
        quotedAt: now,
      },
    });
    claimId = claim.id;
  });

  afterEach(() => setOrganizationCardProvider(null));

  describe("confirm", () => {
    it("needs the referral disclosure acknowledged, and charges nothing without it", async () => {
      await card("STRIPE");
      expect((await confirm({ disclosureAcknowledged: false }).expect(400)).body.code).to.equal("DISCLOSURE_NOT_ACKNOWLEDGED");
      await confirm({}).expect(400);
      expect((await state()).status).to.equal("QUOTED");
      expect(chargeRequests).to.have.length(0);
    });

    it("charges the firm's card once through Stripe and engages the request", async () => {
      await card("STRIPE");
      answers = [ok("pi_1")];
      const { body } = await confirm().expect(200);
      expect(body.status).to.equal("ENGAGED");
      expect(body.engagedAt).to.be.a("string");

      expect(chargeRequests).to.have.length(1);
      expect(chargeRequests[0]).to.deep.include({ attempt: 1, customerId: "cus_test_firm", paymentMethodId: "stripe_pm_1", amountMinor: CLIENT_REQUEST_PER_CASE_FEE_MINOR, currency: "GBP" });
      expect(chargeRequests[0]!.metadata).to.deep.include({ organizationId: orgId, requestId });

      const s = await state();
      expect(s.status).to.equal("ENGAGED");
      expect(s.claim).to.deep.include({ outcome: "ENGAGED", openRequestId: null });
      expect(s.charges).to.have.length(1);
      expect(s.charges[0]).to.deep.include({ kind: "PER_CASE_FEE", status: "SUCCEEDED", provider: "STRIPE", paymentIntentId: "pi_1", attempts: 1, organizationId: orgId, lawyerId });

      const lawyer = (await lawyerView().expect(200)).body;
      expect(lawyer.perCaseFee).to.deep.equal({ amountMinor: CLIENT_REQUEST_PER_CASE_FEE_MINOR, currency: "GBP" });
      expect(lawyer.charge).to.deep.include({ status: "SUCCEEDED", failureReason: null });
      expect((await notificationsFor(lawyerId)).map((n) => n.title)).to.deep.equal(["A client confirmed you", "You're engaged on a client request"]);
    });

    it("charges a dummy test card without Stripe", async () => {
      await card("DUMMY");
      expect((await confirm().expect(200)).body.status).to.equal("ENGAGED");
      expect(chargeRequests).to.have.length(0);
      expect((await state()).charges[0]).to.deep.include({ status: "SUCCEEDED", provider: "DUMMY" });
    });

    it("charges once however many times it's confirmed at once", async () => {
      await card("STRIPE");
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => confirm()));
      expect(results.filter((r) => r.status === 200)).to.have.length(1);
      expect(results.filter((r) => r.status === 409)).to.have.length(4);
      expect(chargeRequests).to.have.length(1);
      expect((await state()).charges).to.have.length(1);
    });

    it("can't confirm a request that isn't quoted", async () => {
      await prisma.clientRequest.update({ where: { id: requestId }, data: { status: "CLAIMED" } });
      expect((await confirm().expect(409)).body.code).to.equal("INVALID_REQUEST_STATUS");
    });
  });

  describe("a declined card", () => {
    it("keeps the request CONFIRMED and tells the lawyer and the firm's admins, not other members", async () => {
      await card("STRIPE");
      answers = [declined("pi_1")];
      const { body } = await confirm().expect(200);
      expect(body.status).to.equal("CONFIRMED");
      const s = await state();
      expect(s.status).to.equal("CONFIRMED");
      expect(s.claim.outcome).to.equal(null);
      expect(s.charges[0]).to.deep.include({ status: "FAILED", failureReason: "Your card was declined.", attempts: 1 });

      for (const id of [lawyerId, adminId]) {
        expect((await notificationsFor(id)).map((n) => n.title), id).to.include("The introduction fee couldn't be charged");
      }
      expect(await notificationsFor(memberId)).to.have.length(0);
      expect((await lawyerView().expect(200)).body.charge).to.deep.include({ status: "FAILED", failureReason: "Your card was declined." });
    });

    it("can be retried by the lawyer once the card is updated, as a new payment", async () => {
      await card("STRIPE");
      answers = [declined("pi_1"), declined("pi_2"), ok("pi_3")];
      await confirm().expect(200);
      const again = await retry().expect(402);
      expect(again.body.code).to.equal("CHARGE_FAILED");
      const { body } = await retry().expect(200);
      expect(body.status).to.equal("ENGAGED");
      expect(chargeRequests.map((r) => r.attempt)).to.deep.equal([1, 2, 3]);
      expect((await state()).charges[0]).to.deep.include({ status: "SUCCEEDED", paymentIntentId: "pi_3", attempts: 3 });
    });

    it("fails without a card on file, and goes through once one is added", async () => {
      const { body } = await confirm().expect(200);
      expect(body.status).to.equal("CONFIRMED");
      expect((await state()).charges[0]!.failureReason).to.match(/no card on file/i);
      expect(chargeRequests).to.have.length(0);
      await card("STRIPE");
      expect((await retry().expect(200)).body.status).to.equal("ENGAGED");
    });

    it("never runs two retries at once", async () => {
      await card("STRIPE");
      answers = [declined("pi_1")];
      await confirm().expect(200);
      const results = await Promise.all([retry(), retry(), retry()]);
      expect(results.filter((r) => r.status === 200)).to.have.length(1);
      expect(chargeRequests).to.have.length(2);
    });

    it("refuses a retry from anyone but the lawyer holding it, or when nothing failed", async () => {
      await card("STRIPE");
      answers = [declined("pi_1")];
      await confirm().expect(200);
      await retry(otherLawyerId, otherOrgId).expect(404);
      await retry().expect(200);
      expect((await retry().expect(409)).body.code).to.equal("INVALID_REQUEST_STATUS");
    });
  });

  describe("when Stripe answers later", () => {
    it("waits CONFIRMED while the payment is processing, and the webhook engages it, once", async () => {
      await card("STRIPE");
      answers = [processing("pi_1")];
      expect((await confirm().expect(200)).body.status).to.equal("CONFIRMED");
      const charge = (await state()).charges[0]!;
      expect(charge).to.deep.include({ status: "PENDING", paymentIntentId: "pi_1" });
      await retry().expect(409);

      stripeNow.set("pi_1", ok("pi_1"));
      await webhook("payment_intent.succeeded", "pi_1", charge.id);
      await webhook("payment_intent.succeeded", "pi_1", charge.id);
      const s = await state();
      expect(s.status).to.equal("ENGAGED");
      expect(s.charges[0]).to.deep.include({ status: "SUCCEEDED", receiptUrl: "https://pay.stripe.com/receipts/pi_1" });
      expect((await notificationsFor(lawyerId)).filter((n) => n.title === "You're engaged on a client request")).to.have.length(1);
    });

    it("the webhook fails a payment that was declined later", async () => {
      await card("STRIPE");
      answers = [processing("pi_1")];
      await confirm().expect(200);
      const charge = (await state()).charges[0]!;
      stripeNow.set("pi_1", declined("pi_1"));
      await webhook("payment_intent.payment_failed", "pi_1", charge.id);
      expect((await state()).charges[0]).to.deep.include({ status: "FAILED" });
    });

    it("an attempt with no answer is retried with the same idempotency key, so Stripe can't charge twice", async () => {
      await card("STRIPE");
      answers = [new Error("socket hang up"), ok("pi_1")];
      expect((await confirm().expect(200)).body.status).to.equal("CONFIRMED");
      expect((await state()).charges[0]).to.deep.include({ status: "FAILED", attempts: 0 });
      await retry().expect(200);
      // Both calls were attempt 1: the same key, so Stripe replays the first payment if it happened.
      expect(chargeRequests.map((r) => r.attempt)).to.deep.equal([1, 1]);
    });

    it("records money Stripe took even after we'd marked the attempt failed", async () => {
      await card("STRIPE");
      answers = [new Error("timeout")];
      await confirm().expect(200);
      const charge = (await state()).charges[0]!;
      stripeNow.set("pi_late", ok("pi_late"));
      await webhook("payment_intent.succeeded", "pi_late", charge.id);
      const s = await state();
      expect(s.status).to.equal("ENGAGED");
      expect(s.charges[0]).to.deep.include({ status: "SUCCEEDED", paymentIntentId: "pi_late" });
    });

    it("ignores a payment that isn't one of our charges", async () => {
      await webhook("payment_intent.succeeded", "pi_other", crypto.randomUUID());
      expect((await state()).status).to.equal("QUOTED");
    });
  });

  describe("decline", () => {
    it("charges nothing, ends the claim DECLINED and routes the request again without that lawyer", async () => {
      await card("STRIPE");
      const { body } = await decline({ reason: "  Found someone closer.  " }).expect(200);
      expect(body).to.deep.include({ status: "ROUTED", lawyer: null, quote: null });
      const row = await prisma.clientRequest.findUniqueOrThrow({ where: { id: requestId }, include: { claims: true, charges: true } });
      expect(row.excludedLawyerIds).to.include(lawyerId);
      expect(row.charges).to.have.length(0);
      expect(row.claims[0]).to.deep.include({ outcome: "DECLINED", declineReason: "Found someone closer.", openRequestId: null });
      expect(chargeRequests).to.have.length(0);
      expect((await notificationsFor(lawyerId)).map((n) => n.title)).to.deep.equal(["A client chose not to go ahead"]);
    });

    it("only while QUOTED: not once confirmed", async () => {
      await card("STRIPE");
      answers = [declined("pi_1")];
      await confirm().expect(200);
      expect((await decline().expect(409)).body.code).to.equal("INVALID_REQUEST_STATUS");
    });
  });

  describe("fee history", () => {
    it("lists the firm's charges for its OWNER and ADMIN, with the lawyer and receipt", async () => {
      await card("STRIPE");
      answers = [ok("pi_1")];
      await confirm().expect(200);
      for (const as of [lawyerId, adminId]) {
        const { body } = await fees(as).expect(200);
        expect(body.total).to.equal(1);
        expect(body.data[0]).to.deep.include({
          kind: "PER_CASE_FEE",
          status: "SUCCEEDED",
          amount: { amountMinor: CLIENT_REQUEST_PER_CASE_FEE_MINOR, currency: "GBP" },
          requestId,
          lawyer: { id: lawyerId, name: "Lena Lawyer" },
          receiptUrl: "https://pay.stripe.com/receipts/pi_1",
        });
      }
      await fees(memberId).expect(403);
      await fees(otherLawyerId).expect(403);
      const filtered = await request(app).get(`/api/organizations/${orgId}/billing/fees?kind=AI_TOP_UP`).set(auth(lawyerId)).expect(200);
      expect(filtered.body.total).to.equal(0);
      expect(claimId).to.be.a("string");
    });
  });
});
