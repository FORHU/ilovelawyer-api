/** Buying an AI top-up pack for an engagement (#516): POST /client-requests/:id/ai-top-ups and GET
 * /billing/top-up-packs. Never without the lawyer's approval, charged to the per-case fee's card,
 * credit added only once the payment goes through (direct answer or Stripe's webhook), and shown in
 * the fee history. Through the real routes against the real database, on the engage-then-copy flow
 * the #515 budget tests already set up. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import request from "supertest";
import type Stripe from "stripe";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { givePracticeArea } from "./support/practice-area-fixture";
import loginToken from "../src/utils/loginToken";
import * as socket from "../src/lib/socket";
import CaseCopyQueue from "../src/queues/case-copy.queue";
import OrganizationChargeSvc from "../src/services/organization-charge.service";
import { ENGAGEMENT_AI_BUDGET_GBP_PER_USD, ENGAGEMENT_AI_BUDGET_INCLUDED_USD } from "../src/config";
import { LAWYER_PRICING_DEFAULTS } from "../src/constants/lawyer-pricing.constants";
import { setOrganizationCardProvider, type CardChargeRequest, type CardChargeResult, type HostedOrganizationCardProvider } from "../src/payments/organization-card-provider";

const INCLUDED_MINOR = Math.round(ENGAGEMENT_AI_BUDGET_INCLUDED_USD * ENGAGEMENT_AI_BUDGET_GBP_PER_USD * 100);
// The UK tenant's pack, as seeded (lawyer_pricing_seed): these tests don't edit it.
const SEEDED = LAWYER_PRICING_DEFAULTS.packs[0];
const PACK = { id: SEEDED.code, name: SEEDED.name, priceMinor: SEEDED.priceMinor, creditMinor: SEEDED.creditMinor };

const SUCCEEDED = (req: CardChargeRequest): CardChargeResult => ({ status: "SUCCEEDED", paymentIntentId: `pi_${req.chargeId}_${req.attempt}`, receiptUrl: "https://pay.stripe.com/receipts/x", failureReason: null });
const DECLINED = (req: CardChargeRequest): CardChargeResult => ({ status: "FAILED", paymentIntentId: `pi_${req.chargeId}_${req.attempt}`, receiptUrl: null, failureReason: "Your card was declined." });
const PENDING = (req: CardChargeRequest): CardChargeResult => ({ status: "PENDING", paymentIntentId: `pi_${req.chargeId}_${req.attempt}`, receiptUrl: null, failureReason: null });

describe("engagement AI top-ups", () => {
  const lawyerId = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  let requestId: string;
  let copyCaseId: string;

  // What the fake Stripe answers to the next top-up (the per-case fee at confirm always succeeds).
  let topUpAnswer: (req: CardChargeRequest) => CardChargeResult = SUCCEEDED;
  let intentStatus: CardChargeResult = { status: "PENDING", paymentIntentId: null, receiptUrl: null, failureReason: null };
  let charged: CardChargeRequest[] = [];
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
    async charge(req: CardChargeRequest): Promise<CardChargeResult> {
      charged.push(req);
      return req.description.includes("top-up") ? topUpAnswer(req) : SUCCEEDED(req);
    },
    async chargeStatus() {
      return intentStatus;
    },
    async refund() {
      throw new Error("not used");
    },
  };

  const emitted: { userId: string; event: string; payload: unknown }[] = [];
  const realEmit = socket.emitToUser;

  const auth = (id: string) => ({ Authorization: `Bearer ${loginToken(id, false).accessToken}` });
  const asLawyer = { ...auth(lawyerId), "X-Organization-Id": orgId };
  const confirm = () => request(app).post(`/api/client/lawyer-requests/${requestId}/confirm`).set(auth(clientId)).send({ disclosureAcknowledged: true });
  const copy = () => request(app).post(`/api/client-requests/${requestId}/copy`).set(asLawyer);
  const aiBudget = () => request(app).get(`/api/client-requests/${requestId}/ai-budget`).set(asLawyer);
  const topUp = (body: object = { packId: PACK.id, approved: true }) => request(app).post(`/api/client-requests/${requestId}/ai-top-ups`).set(asLawyer).send(body);
  const fees = () => request(app).get(`/api/organizations/${orgId}/billing/fees?kind=AI_TOP_UP`).set(asLawyer);
  const topUps = () => prisma.organizationCharge.findMany({ where: { requestId, kind: "AI_TOP_UP" } });

  before(async () => {
    const tenant = await prisma.tenant.upsert({ where: { code: "UK" }, update: {}, create: { code: "UK", name: "United Kingdom" } });
    const standardPlan = await prisma.paymentPlan.findFirstOrThrow({ where: { tenantId: tenant.id, planType: "B2B_SUBSCRIPTION", code: "standard" } });
    await prisma.user.createMany({
      data: [
        { id: lawyerId, email: `topup-lawyer-${lawyerId}@example.com`, username: `topup-lawyer-${lawyerId}`, name: "Tom Topup", role: "LAWYER", tenantId: tenant.id, paymentPlanId: standardPlan.id },
        { id: clientId, email: `topup-client-${clientId}@example.com`, username: `topup-client-${clientId}`, name: "Clara Client", role: "USER", tenantId: tenant.id },
      ],
    });
    await prisma.organization.create({
      data: { id: orgId, name: "Topup Law LLP", slug: `topup-${orgId}`, tenantId: tenant.id, createdById: lawyerId, members: { create: { userId: lawyerId, role: "OWNER", status: "ACCEPTED" } } },
    });
    await prisma.lawyerClientProfile.create({
      data: { userId: lawyerId, acceptingRequests: true, verificationStatus: "VERIFIED", verifiedAt: new Date() },
    });
    await givePracticeArea([lawyerId]);
    await prisma.lawyerUkRegistration.create({ data: { userId: lawyerId, regulator: "SRA", registrationNumber: "998", qualifiedJurisdictions: ["England and Wales"] } });
    await prisma.case.create({ data: { id: caseId, userId: clientId, caseName: "Top-up test case", caseAreas: ["EMPLOYMENT"], ukJurisdiction: "England and Wales" } });
    await prisma.organizationBilling.create({ data: { organizationId: orgId, provider: "STRIPE", customerId: "cus_topup", paymentMethodId: "stripe_pm_topup", brand: "visa", last4: "4242" } });
  });

  after(async () => {
    Object.assign(socket, { emitToUser: realEmit });
    await prisma.notification.deleteMany({ where: { userId: lawyerId } });
    await prisma.llmUsage.deleteMany({ where: { OR: [{ caseId }, { caseId: copyCaseId }] } });
    await prisma.organizationCharge.deleteMany({ where: { organizationId: orgId } });
    await prisma.clientRequest.deleteMany({ where: { caseId } });
    await prisma.case.deleteMany({ where: { OR: [{ id: caseId }, { copiedFromCaseId: caseId }] } });
    await prisma.organizationBilling.deleteMany({ where: { organizationId: orgId } });
    await prisma.lawyerClientProfile.deleteMany({ where: { userId: lawyerId } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: [lawyerId, clientId] } } });
    await prisma.organization.deleteMany({ where: { OR: [{ id: orgId }, { createdById: clientId }] } });
    await prisma.user.deleteMany({ where: { id: { in: [lawyerId, clientId] } } });
  });

  beforeEach(async () => {
    setOrganizationCardProvider(fakeStripe);
    topUpAnswer = SUCCEEDED;
    intentStatus = { status: "PENDING", paymentIntentId: null, receiptUrl: null, failureReason: null };
    charged = [];
    emitted.length = 0;
    Object.assign(socket, { emitToUser: (userId: string, event: string, payload: unknown) => emitted.push({ userId, event, payload }) });
    await prisma.organizationBilling.update({ where: { organizationId: orgId }, data: { paymentMethodId: "stripe_pm_topup" } });
    await prisma.llmUsage.deleteMany({ where: { OR: [{ caseId }, { caseId: copyCaseId ?? "none" }] } });
    await prisma.organizationCharge.deleteMany({ where: { organizationId: orgId } });
    await prisma.clientRequest.deleteMany({ where: { caseId } });

    const now = new Date();
    const row = await prisma.clientRequest.create({
      data: { caseId, clientId, consentVersion: "test", consentAcceptedAt: now, status: "ROUTED", routedAt: now, routingExpiresAt: new Date(now.getTime() + 48 * 3_600_000), pickByAt: new Date(now.getTime() + 7 * 86_400_000) },
    });
    requestId = row.id;
    await prisma.clientRequestClaim.create({
      data: { requestId, lawyerId, organizationId: orgId, claimedAt: now, expiresAt: new Date(now.getTime() + 86_400_000), quoteType: "FIXED_FEE", quoteAmountMinor: 75000, quoteCurrency: "GBP", quoteMessage: "Fixed fee.", quotedAt: now },
    });
    await confirm().expect(200);
    const { body } = await copy().expect(202);
    await CaseCopyQueue.tick();
    copyCaseId = (await prisma.caseCopy.findUniqueOrThrow({ where: { id: body.caseCopyId } })).copyCaseId!;
    charged = [];
  });

  afterEach(() => Object.assign(socket, { emitToUser: realEmit }));

  describe("GET /billing/top-up-packs", () => {
    it("lists the packs, price and credit", async () => {
      const { body } = await request(app).get("/api/billing/top-up-packs").set(auth(lawyerId)).expect(200);
      expect(body).to.deep.equal([{ id: PACK.id, name: PACK.name, price: { amountMinor: PACK.priceMinor, currency: "GBP" }, credit: { amountMinor: PACK.creditMinor, currency: "GBP" } }]);
    });

    it("needs a session", async () => {
      await request(app).get("/api/billing/top-up-packs").expect(401);
    });
  });

  describe("POST /client-requests/:id/ai-top-ups", () => {
    it("charges the firm's card once approved and adds the pack's credit to the budget", async () => {
      const { body } = await topUp().expect(202);
      expect(body.kind).to.equal("AI_TOP_UP");
      expect(body.status).to.equal("SUCCEEDED");
      expect(body.amount).to.deep.equal({ amountMinor: PACK.priceMinor, currency: "GBP" });
      expect(body.credit).to.deep.equal({ amountMinor: PACK.creditMinor, currency: "GBP" });
      expect(charged).to.have.length(1);
      expect(charged[0]).to.include({ customerId: "cus_topup", paymentMethodId: "stripe_pm_topup", amountMinor: PACK.priceMinor, currency: "GBP" });

      const budget = (await aiBudget().expect(200)).body;
      expect(budget.toppedUp).to.deep.equal({ amountMinor: PACK.creditMinor, currency: "GBP" });
      expect(budget.remaining.amountMinor).to.equal(INCLUDED_MINOR + PACK.creditMinor);

      const sent = emitted.find((e) => e.event === "engagement:ai-budget");
      expect(sent?.userId).to.equal(lawyerId);
      expect(sent?.payload).to.deep.include({ requestId, state: "OK" });
    });

    it("lets AI work carry on once a spent budget is topped up", async () => {
      await prisma.llmUsage.create({
        data: { provider: "OPENAI", feature: "chat", source: "ESTIMATED", inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: ENGAGEMENT_AI_BUDGET_INCLUDED_USD, caseId: copyCaseId },
      });
      expect((await aiBudget().expect(200)).body.state).to.equal("EXHAUSTED");
      await topUp().expect(202);
      expect((await aiBudget().expect(200)).body.state).to.not.equal("EXHAUSTED");
    });

    it("shows in the fee history with its credit", async () => {
      await topUp().expect(202);
      const { body } = await fees().expect(200);
      expect(body.total).to.equal(1);
      expect(body.data[0]).to.deep.include({ kind: "AI_TOP_UP", status: "SUCCEEDED", requestId });
      expect(body.data[0].credit).to.deep.equal({ amountMinor: PACK.creditMinor, currency: "GBP" });
    });

    it("never charges without the lawyer's approval", async () => {
      await topUp({ packId: PACK.id }).expect(400);
      await topUp({ packId: PACK.id, approved: false }).expect(400);
      expect(charged).to.have.length(0);
      expect(await topUps()).to.have.length(0);
    });

    it("refuses a pack that doesn't exist", async () => {
      await topUp({ packId: "huge", approved: true }).expect(400);
      expect(await topUps()).to.have.length(0);
    });

    it("402 CARD_REQUIRED with no card on file, recording nothing", async () => {
      await prisma.organizationBilling.update({ where: { organizationId: orgId }, data: { paymentMethodId: null } });
      const { body } = await topUp().expect(402);
      expect(body.code).to.equal("CARD_REQUIRED");
      expect(await topUps()).to.have.length(0);
    });

    it("402 CHARGE_FAILED when declined: no credit, the failure in the fee history, the lawyer told", async () => {
      topUpAnswer = DECLINED;
      const { body } = await topUp().expect(402);
      expect(body.code).to.equal("CHARGE_FAILED");
      expect((await aiBudget().expect(200)).body.toppedUp.amountMinor).to.equal(0);
      expect((await fees().expect(200)).body.data[0]).to.deep.include({ status: "FAILED", failureReason: "Your card was declined." });
      expect(await prisma.notification.count({ where: { userId: lawyerId, title: "Your AI top-up couldn't be charged" } })).to.equal(1);
    });

    it("adds the credit only when Stripe's webhook says a pending payment went through", async () => {
      topUpAnswer = PENDING;
      const { body } = await topUp().expect(202);
      expect(body.status).to.equal("PENDING");
      expect((await aiBudget().expect(200)).body.toppedUp.amountMinor).to.equal(0);

      // A second click while it's pending buys nothing more.
      const busy = await topUp().expect(409);
      expect(busy.body.code).to.equal("INVALID_REQUEST_STATUS");
      expect(await topUps()).to.have.length(1);

      const charge = (await topUps())[0];
      intentStatus = { status: "SUCCEEDED", paymentIntentId: charge.paymentIntentId, receiptUrl: "https://pay.stripe.com/receipts/y", failureReason: null };
      await OrganizationChargeSvc.applyStripeIntent({ id: charge.paymentIntentId!, metadata: { chargeId: charge.id } } as unknown as Stripe.PaymentIntent);

      expect((await aiBudget().expect(200)).body.toppedUp.amountMinor).to.equal(PACK.creditMinor);
      expect(emitted.some((e) => e.event === "engagement:ai-budget")).to.equal(true);
    });

    it("keeps a refunded top-up's credit: it bought AI that was used", async () => {
      await topUp().expect(202);
      await prisma.organizationCharge.updateMany({ where: { requestId, kind: "AI_TOP_UP" }, data: { status: "REFUNDED" } });
      expect((await aiBudget().expect(200)).body.toppedUp.amountMinor).to.equal(PACK.creditMinor);
    });

    it("409 once the engagement is closed", async () => {
      await prisma.clientRequest.update({ where: { id: requestId }, data: { status: "CLOSED", closedAt: new Date(), closedBy: "LAWYER" } });
      const { body } = await topUp().expect(409);
      expect(body.code).to.equal("INVALID_REQUEST_STATUS");
      expect(charged).to.have.length(0);
    });

    it("refuses anyone but the engaged lawyer", async () => {
      await request(app).post(`/api/client-requests/${requestId}/ai-top-ups`).send({ packId: PACK.id, approved: true }).expect(401);
      await request(app).post(`/api/client-requests/${requestId}/ai-top-ups`).set(auth(clientId)).send({ packId: PACK.id, approved: true }).expect((res) => {
        expect(res.status).to.be.oneOf([403, 404]);
      });
    });
  });
});
