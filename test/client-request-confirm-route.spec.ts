/** The client confirms (accepts) or declines the quote and pays it, and what the engagement then allows:
 * POST /client/lawyer-requests/:id/confirm and /decline, paying through POST .../quotations/:id/payment
 * (the dummy provider), copy, read-only access, close, end and feedback. A request accepted before
 * quotation payments keeps its per-case fee, and POST /client-requests/:id/charge/retry still retries
 * it. Through the real routes against the real database, with its own UK firm, lawyer, client, case and
 * request. The firm's card is charged through a fake provider whose answers each test sets. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import request from "supertest";
import type Stripe from "stripe";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { givePracticeArea } from "./support/practice-area-fixture";
import loginToken from "../src/utils/loginToken";
import ClientBillingSvc from "../src/services/client-billing.service";
import CaseCopyQueue from "../src/queues/case-copy.queue";
import {
  setOrganizationCardProvider,
  ORGANIZATION_CHARGE_PURPOSE,
  type CardChargeRequest,
  type CardChargeResult,
  type HostedOrganizationCardProvider,
} from "../src/payments/organization-card-provider";
import { LAWYER_PRICING_DEFAULTS } from "../src/constants/lawyer-pricing.constants";
import { sentQuotation, cleanQuotationMoney } from "./support/quotation-fixture";

// The UK tenant's introduction fee, as seeded (lawyer_pricing_seed): these tests don't edit it.
const CLIENT_REQUEST_PER_CASE_FEE_MINOR = LAWYER_PRICING_DEFAULTS.introFee.priceMinor;

const HOUR_MS = 60 * 60 * 1000;

describe("client confirms and pays, and the engagement", () => {
  const lawyerId = crypto.randomUUID();
  const adminId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const otherLawyerId = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const otherOrgId = crypto.randomUUID();
  const clientOrgId = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  const webhookEvents: string[] = [];
  let requestId: string;
  let claimId: string;
  let quotationId: string;

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
  const pay = (id = quotationId) => request(app).post(`/api/client/lawyer-requests/${requestId}/quotations/${id}/payment`).set(auth(clientId)).send({});
  /** Accepted and paid: ENGAGED. */
  const engage = async () => {
    await confirm().expect(200);
    return (await pay().expect(200)).body;
  };
  const decline = (body: object = {}) => request(app).post(`/api/client/lawyer-requests/${requestId}/decline`).set(auth(clientId)).send(body);
  const clientView = () => request(app).get(`/api/client/lawyer-requests/${requestId}`).set(auth(clientId));
  const retry = (id = lawyerId, org = orgId) => request(app).post(`/api/client-requests/${requestId}/charge/retry`).set({ ...auth(id), "X-Organization-Id": org });
  const lawyerView = () => request(app).get(`/api/client-requests/${requestId}`).set({ ...auth(lawyerId), "X-Organization-Id": orgId });
  const fees = (as = lawyerId) => request(app).get(`/api/organizations/${orgId}/billing/fees`).set(auth(as));
  const copy = (id = lawyerId, org = orgId) => request(app).post(`/api/client-requests/${requestId}/copy`).set({ ...auth(id), "X-Organization-Id": org });
  const close = (body: object = {}, id = lawyerId, org = orgId) => request(app).post(`/api/client-requests/${requestId}/close`).set({ ...auth(id), "X-Organization-Id": org }).send(body);
  const end = (body: object = {}) => request(app).post(`/api/client/lawyer-requests/${requestId}/end`).set(auth(clientId)).send(body);
  const feedback = (body: object) => request(app).post(`/api/client/lawyer-requests/${requestId}/feedback`).set(auth(clientId)).send(body);

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
    // The client's own personal workspace, like a real client case's (ADR 0016): a confirmed
    // engagement reaches it as a guest of this portfolio, the same way a shared case does.
    await prisma.organization.create({
      data: {
        id: clientOrgId,
        name: "Clara Client",
        slug: `confirm-${clientOrgId}`,
        tenantId: tenant.id,
        createdById: clientId,
        isPersonal: true,
        members: { create: { userId: clientId, role: "OWNER", status: "ACCEPTED" } },
      },
    });
    const profile = { acceptingRequests: true, verificationStatus: "VERIFIED" as const, verifiedAt: new Date() };
    await prisma.lawyerClientProfile.createMany({ data: [{ ...profile, userId: lawyerId }, { ...profile, userId: otherLawyerId }] });
    await givePracticeArea([lawyerId, otherLawyerId]);
    const registration = { regulator: "SRA", qualifiedJurisdictions: ["England and Wales"] };
    await prisma.lawyerUkRegistration.createMany({ data: [{ ...registration, userId: lawyerId, registrationNumber: "111" }, { ...registration, userId: otherLawyerId, registrationNumber: "222" }] });
    await prisma.case.create({ data: { id: caseId, userId: clientId, organizationId: clientOrgId, caseName: "Unfair dismissal", caseAreas: ["EMPLOYMENT"], ukJurisdiction: "England and Wales" } });
  });

  after(async () => {
    await cleanQuotationMoney({ organizationIds: [orgId, otherOrgId] }, [clientId]);
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
    // A request the lawyer has joined and quoted on: still ROUTED, with their quote open and the
    // client's 7 days to pick running (several lawyers, phase 5).
    const now = new Date();
    const row = await prisma.clientRequest.create({
      data: {
        caseId,
        clientId,
        consentVersion: "test",
        consentAcceptedAt: now,
        status: "ROUTED",
        routedAt: now,
        routingExpiresAt: new Date(now.getTime() + 48 * HOUR_MS),
        pickByAt: new Date(now.getTime() + 7 * 24 * HOUR_MS),
      },
    });
    requestId = row.id;
    const claim = await prisma.clientRequestClaim.create({
      data: {
        requestId,
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
    quotationId = (await sentQuotation(claim)).id;
  });

  afterEach(() => setOrganizationCardProvider(null));

  describe("confirm", () => {
    it("needs the disclosure acknowledged, and changes nothing without it", async () => {
      expect((await confirm({ disclosureAcknowledged: false }).expect(400)).body.code).to.equal("DISCLOSURE_NOT_ACKNOWLEDGED");
      await confirm({}).expect(400);
      expect((await state()).status).to.equal("ROUTED");
    });

    it("accepts the quote without charging the firm, and the client's payment engages the request", async () => {
      const { body } = await confirm().expect(200);
      expect(body).to.deep.include({ status: "CONFIRMED", awaitingPayment: true });
      expect(body.quotation).to.deep.include({ status: "ACCEPTED" });
      expect(chargeRequests).to.have.length(0);
      expect((await state()).charges).to.have.length(0);
      expect((await notificationsFor(lawyerId)).map((n) => n.title)).to.deep.equal(["A client accepted your quote"]);

      const paid = await pay().expect(200);
      expect(paid.body.payment.status).to.equal("SUCCEEDED");
      const s = await state();
      expect(s.status).to.equal("ENGAGED");
      expect(s.engagedAt).to.be.instanceOf(Date);
      expect(s.claim).to.deep.include({ outcome: "ENGAGED", openRequestId: null });
      expect(s.charges).to.have.length(0);

      const lawyer = (await lawyerView().expect(200)).body;
      expect(lawyer.charge).to.equal(null);
      expect(lawyer.quotation).to.deep.include({ status: "PAID" });
      expect((await notificationsFor(lawyerId)).map((n) => n.title)).to.deep.equal(["A client accepted your quote", "You're engaged on a client request"]);
    });

    it("grants the engaged lawyer read-only access to the client's case", async () => {
      await engage();
      const access = await prisma.caseAccess.findUnique({ where: { caseId_userId: { caseId, userId: lawyerId } } });
      expect(access?.permission).to.equal("VIEW");
    });

    it("accepts once however many times it's confirmed at once", async () => {
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => confirm()));
      expect(results.filter((r) => r.status === 200)).to.have.length(1);
      expect(results.filter((r) => r.status === 409)).to.have.length(4);
      expect((await prisma.quotation.findUniqueOrThrow({ where: { id: quotationId } })).status).to.equal("ACCEPTED");
    });

    it("can't confirm a request with no quote open", async () => {
      await prisma.clientRequestClaim.update({ where: { id: claimId }, data: { quotedAt: null } });
      expect((await confirm().expect(409)).body.code).to.equal("INVALID_REQUEST_STATUS");
    });
  });

  describe("copy", () => {
    beforeEach(async () => {
      await engage();
    });

    it("queues a workspace copy for the lawyer and finishes it through the copy queue", async () => {
      const { body, status } = await copy();
      expect(status).to.equal(202);
      expect(body.status).to.equal("PENDING");
      expect(body.caseCopyId).to.be.a("string");

      await CaseCopyQueue.tick();

      const job = await prisma.caseCopy.findUniqueOrThrow({ where: { id: body.caseCopyId } });
      expect(job.status).to.equal("DONE");
      expect(job.copyCaseId).to.be.a("string");

      const copied = await prisma.case.findUniqueOrThrow({ where: { id: job.copyCaseId! } });
      expect(copied).to.deep.include({ organizationId: orgId, copiedFromCaseId: caseId, caseName: "Unfair dismissal" });

      const updatedRequest = await prisma.clientRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(updatedRequest.copyCaseId).to.equal(job.copyCaseId);
    });

    it("doesn't queue a second copy for a second call", async () => {
      const first = await copy().expect(202);
      const second = await copy().expect(202);
      expect(second.body.caseCopyId).to.equal(first.body.caseCopyId);
      expect(await prisma.caseCopy.count({ where: { requestId } })).to.equal(1);
    });

    it("refuses a lawyer who isn't the one engaged on the request", async () => {
      await copy(otherLawyerId, otherOrgId).expect(404);
    });

    it("can't be copied before the engagement", async () => {
      await prisma.clientRequest.update({ where: { id: requestId }, data: { status: "CONFIRMED" } });
      expect((await copy().expect(409)).body.code).to.equal("INVALID_REQUEST_STATUS");
    });
  });

  describe("read-only access to the client's case", () => {
    const asGuest = (id = lawyerId) => ({ ...auth(id), "X-Organization-Id": clientOrgId });

    beforeEach(async () => {
      await engage();
    });

    it("tells the lawyer which workspace to open the client's case in", async () => {
      const { body } = await lawyerView().expect(200);
      expect(body.engagement).to.include({ caseId, workspaceId: clientOrgId });
    });

    it("lets the engaged lawyer read the client's case as a guest of their portfolio", async () => {
      const { body } = await request(app).get(`/api/my-cases/${caseId}`).set(asGuest()).expect(200);
      expect(body.id).to.equal(caseId);
    });

    it("refuses every write the engaged lawyer makes on the client's case", async () => {
      const { body } = await request(app).post(`/api/my-cases/${caseId}/archive`).set(asGuest()).expect(403);
      expect(body.code).to.equal("SHARE_READ_ONLY");
    });

    it("gives a lawyer who isn't engaged on this case no access at all", async () => {
      await request(app).get(`/api/my-cases/${caseId}`).set(asGuest(otherLawyerId)).expect(403);
    });
  });

  describe("close", () => {
    const asGuest = (id = lawyerId) => ({ ...auth(id), "X-Organization-Id": clientOrgId });

    beforeEach(async () => {
      await engage();
    });

    it("closes the engagement and removes the lawyer's access", async () => {
      const { body } = await close().expect(200);
      expect(body.status).to.equal("CLOSED");
      expect(body.engagement).to.include({ closedBy: "LAWYER" });
      expect(body.engagement.closedAt).to.be.a("string");

      expect(await prisma.caseAccess.findUnique({ where: { caseId_userId: { caseId, userId: lawyerId } } })).to.equal(null);
      await request(app).get(`/api/my-cases/${caseId}`).set(asGuest()).expect(403);
    });

    it("keeps the lawyer's workspace copy made before close", async () => {
      const { body: copied } = await copy().expect(202);
      await CaseCopyQueue.tick();
      await close().expect(200);

      const job = await prisma.caseCopy.findUniqueOrThrow({ where: { id: copied.caseCopyId } });
      expect(job.status).to.equal("DONE");
      expect(await prisma.case.findUnique({ where: { id: job.copyCaseId! } })).to.not.equal(null);
    });

    it("can't be closed twice", async () => {
      await close().expect(200);
      expect((await close().expect(409)).body.code).to.equal("INVALID_REQUEST_STATUS");
    });

    it("refuses a lawyer who isn't the one engaged on the request", async () => {
      await close({}, otherLawyerId, otherOrgId).expect(404);
    });
  });

  describe("client ends the engagement", () => {
    beforeEach(async () => {
      await engage();
    });

    it("closes the engagement, closedBy CLIENT, and removes the lawyer's access", async () => {
      const { body } = await end({ reason: "Settled out of court." }).expect(200);
      expect(body.status).to.equal("CLOSED");
      expect(body.closedAt).to.be.a("string");
      expect(body.closedBy).to.equal("CLIENT");

      expect(await prisma.caseAccess.findUnique({ where: { caseId_userId: { caseId, userId: lawyerId } } })).to.equal(null);
    });

    it("tells the lawyer the client ended it", async () => {
      await end({ reason: "Settled out of court." }).expect(200);
      expect((await notificationsFor(lawyerId)).map((n) => n.title)).to.include("The client ended the engagement");
    });

    it("can't be ended before engagement", async () => {
      await prisma.clientRequest.update({ where: { id: requestId }, data: { status: "CONFIRMED" } });
      expect((await end().expect(409)).body.code).to.equal("INVALID_REQUEST_STATUS");
    });
  });

  describe("feedback", () => {
    beforeEach(async () => {
      await engage();
    });

    it("can't be given before the engagement closes", async () => {
      expect((await feedback({ rating: 5 }).expect(409)).body.code).to.equal("INVALID_REQUEST_STATUS");
    });

    it("stores the rating once the engagement is closed, and shows it on the request", async () => {
      await close().expect(200);
      const { body } = await feedback({ rating: 4, comment: "Clear and responsive." }).expect(201);
      expect(body).to.deep.include({ rating: 4, comment: "Clear and responsive." });

      const view = await clientView().expect(200);
      expect(view.body.feedback).to.deep.include({ rating: 4, comment: "Clear and responsive." });
    });

    it("can only be given once", async () => {
      await close().expect(200);
      await feedback({ rating: 4 }).expect(201);
      expect((await feedback({ rating: 2 }).expect(409)).body.code).to.equal("INVALID_REQUEST_STATUS");
    });

    it("needs a rating from 1 to 5", async () => {
      await close().expect(200);
      await feedback({ rating: 0 }).expect(400);
      await feedback({ rating: 6 }).expect(400);
    });
  });

  // Requests the client confirmed before quotation payments: the firm's per-case fee was charged then,
  // and one that failed can still be retried once the card is updated.
  describe("a per-case fee from before quotation payments", () => {
    beforeEach(async () => {
      await prisma.clientRequest.update({ where: { id: requestId }, data: { status: "CONFIRMED", pickByAt: null } });
      await prisma.quotation.update({ where: { id: quotationId }, data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedAmountMinor: 75000 } });
      await prisma.organizationCharge.create({
        data: {
          organizationId: orgId,
          kind: "PER_CASE_FEE",
          status: "FAILED",
          amountMinor: CLIENT_REQUEST_PER_CASE_FEE_MINOR,
          currency: "GBP",
          requestId,
          feeRequestId: requestId,
          lawyerId,
          provider: "STRIPE",
          failureReason: "Your card was declined.",
          attempts: 1,
        },
      });
    });

    it("can be retried by the lawyer once the card is updated, as a new payment", async () => {
      await card("STRIPE");
      answers = [declined("pi_2"), ok("pi_3")];
      expect((await retry().expect(402)).body.code).to.equal("CHARGE_FAILED");
      const { body } = await retry().expect(200);
      expect(body.status).to.equal("ENGAGED");
      expect(chargeRequests.map((r) => r.attempt)).to.deep.equal([2, 3]);
      expect((await state()).charges[0]).to.deep.include({ status: "SUCCEEDED", paymentIntentId: "pi_3", attempts: 3 });
      expect(chargeRequests[1]).to.deep.include({ amountMinor: CLIENT_REQUEST_PER_CASE_FEE_MINOR, currency: "GBP" });
    });

    it("refuses a retry from anyone but the lawyer holding it, or when nothing failed", async () => {
      await card("STRIPE");
      await retry(otherLawyerId, otherOrgId).expect(404);
      await retry().expect(200);
      expect((await retry().expect(409)).body.code).to.equal("INVALID_REQUEST_STATUS");
    });

    it("shows the charge only to the lawyer it's for, and in the firm's fee history for its OWNER and ADMIN", async () => {
      await card("STRIPE");
      answers = [ok("pi_1")];
      await retry().expect(200);
      expect((await lawyerView().expect(200)).body.charge).to.deep.include({ status: "SUCCEEDED" });
      for (const as of [lawyerId, adminId]) {
        const { body } = await fees(as).expect(200);
        expect(body.total).to.equal(1);
        expect(body.data[0]).to.deep.include({ kind: "PER_CASE_FEE", status: "SUCCEEDED", requestId, lawyer: { id: lawyerId, name: "Lena Lawyer" } });
      }
      await fees(memberId).expect(403);
      await fees(otherLawyerId).expect(403);
    });

    it("the webhook settles a payment Stripe finished later", async () => {
      await card("STRIPE");
      answers = [processing("pi_1")];
      expect((await retry().expect(200)).body.status).to.equal("CONFIRMED");
      const charge = (await state()).charges[0]!;
      stripeNow.set("pi_1", ok("pi_1"));
      await webhook("payment_intent.succeeded", "pi_1", charge.id);
      await webhook("payment_intent.succeeded", "pi_1", charge.id);
      expect((await state()).status).to.equal("ENGAGED");
      expect((await notificationsFor(lawyerId)).filter((n) => n.title === "You're engaged on a client request")).to.have.length(1);
    });
  });

  describe("decline", () => {
    it("charges nothing, ends the claim DECLINED and routes the request again without that lawyer", async () => {
      const { body } = await decline({ reason: "  Found someone closer.  " }).expect(200);
      expect(body).to.deep.include({ status: "ROUTED", lawyer: null, quote: null });
      const row = await prisma.clientRequest.findUniqueOrThrow({ where: { id: requestId }, include: { claims: true, charges: true } });
      expect(row.excludedLawyerIds).to.include(lawyerId);
      expect(row.charges).to.have.length(0);
      expect(row.claims[0]).to.deep.include({ outcome: "DECLINED", declineReason: "Found someone closer.", openRequestId: null });
      expect(await prisma.quotation.findUniqueOrThrow({ where: { id: quotationId } })).to.deep.include({ status: "REJECTED", rejectReason: "Found someone closer." });
      expect((await notificationsFor(lawyerId)).map((n) => n.title)).to.deep.equal(["A client chose not to go ahead"]);
    });

    it("only while QUOTED: not once confirmed", async () => {
      await confirm().expect(200);
      expect((await decline().expect(409)).body.code).to.equal("INVALID_REQUEST_STATUS");
    });
  });

  describe("several lawyers' quotes (phase 5)", () => {
    let secondClaimId: string;
    let secondQuotationId: string;
    beforeEach(async () => {
      const now = new Date();
      const second = await prisma.clientRequestClaim.create({
        data: {
          requestId,
          lawyerId: memberId,
          organizationId: orgId,
          claimedAt: now,
          expiresAt: new Date(now.getTime() + 24 * HOUR_MS),
          quoteType: "FIXED_FEE",
          quoteAmountMinor: 60000,
          quoteCurrency: "GBP",
          quoteMessage: "Cheaper fixed fee.",
          quotedAt: now,
        },
      });
      secondClaimId = second.id;
      secondQuotationId = (await sentQuotation(second, 60000)).id;
    });

    it("lists every lawyer's quote for the client, and shows no single lawyer until they pick", async () => {
      const { body } = await request(app).get(`/api/client/lawyer-requests/${requestId}`).set(auth(clientId)).expect(200);
      expect(body).to.deep.include({ status: "QUOTED", lawyer: null, quote: null });
      expect(body.lawyers.map((l: { claimId: string }) => l.claimId)).to.deep.equal([claimId, secondClaimId]);
      expect(body.lawyers[1].quote).to.deep.include({ type: "FIXED_FEE", amount: { amountMinor: 60000, currency: "GBP" } });
      expect(body.pickByAt).to.be.a("string");
    });

    it("needs the client to name which quote, then confirms that one and tells the other lawyer", async () => {
      expect((await confirm().expect(400)).body.code).to.equal("QUOTE_REQUIRED");

      const { body } = await confirm({ disclosureAcknowledged: true, claimId: secondClaimId }).expect(200);
      expect(body).to.deep.include({ status: "CONFIRMED" });
      expect(body.lawyer.id).to.equal(memberId);
      expect((await prisma.quotation.findUniqueOrThrow({ where: { id: quotationId } })).status).to.equal("NOT_CHOSEN");
      await pay(secondQuotationId).expect(200);

      const s = await prisma.clientRequest.findUniqueOrThrow({ where: { id: requestId }, include: { claims: true, charges: true } });
      expect(s.status).to.equal("ENGAGED");
      expect(s.charges).to.have.length(0);
      expect(s.claims.find((c) => c.id === claimId)!.outcome).to.equal("NOT_CHOSEN");
      expect(s.claims.find((c) => c.id === secondClaimId)!.outcome).to.equal("ENGAGED");
      expect((await notificationsFor(lawyerId)).map((n) => n.title)).to.deep.equal(["The client chose another lawyer"]);
    });

    it("declines one quote and leaves the other open", async () => {
      expect((await decline().expect(400)).body.code).to.equal("QUOTE_REQUIRED");
      const { body } = await decline({ claimId }).expect(200);
      expect(body).to.deep.include({ status: "QUOTED" });
      expect(body.lawyers.map((l: { claimId: string }) => l.claimId)).to.deep.equal([secondClaimId]);
    });
  });

  describe("fee history", () => {
    it("has no per-case fee for a request the client paid through ilovelawyer", async () => {
      await engage();
      const { body } = await fees(adminId).expect(200);
      expect(body.total).to.equal(0);
      expect(claimId).to.be.a("string");
    });
  });
});
