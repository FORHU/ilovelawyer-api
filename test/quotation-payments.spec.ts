/** Quotation payments end to end, through the real routes against the real database: the lawyer drafts
 * and sends a quotation (service fee, platform fee on top, their own expiry), the client accepts and
 * pays it through ilovelawyer, the lawyer's service fee lands in their firm's wallet PENDING, the sweep
 * releases it, and they withdraw it. Also the expiry, a free first consultation, refunds, a Stripe
 * PaymentIntent settled by its webhook, and the admin's payout settings. The dummy providers stand in
 * for Stripe unless a test sets a fake. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import request from "supertest";
import type Stripe from "stripe";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { redis } from "../src/lib/redis";
import { givePracticeArea } from "./support/practice-area-fixture";
import loginToken from "../src/utils/loginToken";
import ClientBillingSvc from "../src/services/client-billing.service";
import QuotationPaymentSvc from "../src/services/quotation-payment.service";
import WalletSvc from "../src/services/wallet.service";
import {
  setQuotationPaymentProvider,
  QUOTATION_PAYMENT_PURPOSE,
  type IntentQuotationPaymentProvider,
  type QuotationPaymentResult,
} from "../src/payments/quotation-payment-provider";
import { setPayoutProvider } from "../src/payments/payout-provider";
import { PAYOUT_SETTINGS_DEFAULTS, payoutSettingsCacheKey, platformFeeOf } from "../src/constants/payout.constants";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("quotation payments", function () {
  // Several real requests per test, some through the admin routes.
  this.timeout(15_000);
  const lawyerId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  const adminId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const clientOrgId = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  const webhookEvents: string[] = [];
  let tenantId: string;
  let requestId: string;
  let claimId: string;

  const auth = (id: string) => ({ Authorization: `Bearer ${loginToken(id, false).accessToken}` });
  const asLawyer = { ...auth(lawyerId), "X-Organization-Id": orgId };
  const lawyerView = () => request(app).get(`/api/client-requests/${requestId}`).set(asLawyer);
  const draft = (body: object) => request(app).put(`/api/client-requests/${requestId}/quotation`).set(asLawyer).send(body);
  const send = () => request(app).post(`/api/client-requests/${requestId}/quotation/send`).set(asLawyer);
  const clientView = () => request(app).get(`/api/client/lawyer-requests/${requestId}`).set(auth(clientId));
  const accept = (quotationId: string, body: object = { disclosureAcknowledged: true }) =>
    request(app).post(`/api/client/lawyer-requests/${requestId}/quotations/${quotationId}/accept`).set(auth(clientId)).send(body);
  const pay = (quotationId: string, body: object = {}) => request(app).post(`/api/client/lawyer-requests/${requestId}/quotations/${quotationId}/payment`).set(auth(clientId)).send(body);
  const wallet = (as = lawyerId) => request(app).get(`/api/organizations/${orgId}/wallet`).set(auth(as));
  const withdraw = (amountMinor: number, key = crypto.randomUUID(), as = lawyerId) =>
    request(app).post(`/api/organizations/${orgId}/wallet/withdrawals`).set({ ...auth(as), "Idempotency-Key": key }).send({ amount: { amountMinor, currency: "GBP" } });

  const inDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();
  const FIXED_FEE = (amountMinor = 60000, expiresAt = inDays(5)) => ({ type: "FIXED_FEE", amount: { amountMinor, currency: "GBP" }, message: "I can take this on for a fixed fee.", expiresAt });

  /** Drafts and sends a quote, then returns its id. */
  const quoted = async (body = FIXED_FEE()) => {
    await draft(body).expect(200);
    const { body: after } = await send().expect(200);
    return after.quotation.id as string;
  };
  /** Quoted, accepted and paid with the dummy. */
  const engaged = async (body = FIXED_FEE()) => {
    const id = await quoted(body);
    await accept(id).expect(200);
    await pay(id).expect(200);
    return id;
  };

  before(async () => {
    const tenant = await prisma.tenant.upsert({ where: { code: "UK" }, update: {}, create: { code: "UK", name: "United Kingdom" } });
    tenantId = tenant.id;
    const user = (id: string, name: string, role: "LAWYER" | "USER" | "ADMIN") => ({ id, email: `qpay-${id}@example.com`, username: `qpay-${id}`, name, role, tenantId: tenant.id });
    await prisma.user.createMany({
      data: [user(lawyerId, "Lena Lawyer", "LAWYER"), user(memberId, "Mo Member", "LAWYER"), user(clientId, "Clara Client", "USER"), user(adminId, "Ann Admin", "ADMIN")],
    });
    await prisma.organization.create({
      data: {
        id: orgId,
        name: "Lena Law LLP",
        slug: `qpay-${orgId}`,
        tenantId: tenant.id,
        createdById: lawyerId,
        members: { create: [{ userId: lawyerId, role: "OWNER", status: "ACCEPTED" }, { userId: memberId, role: "MEMBER", status: "ACCEPTED" }] },
      },
    });
    await prisma.organization.create({
      data: { id: clientOrgId, name: "Clara Client", slug: `qpay-${clientOrgId}`, tenantId: tenant.id, createdById: clientId, isPersonal: true, members: { create: { userId: clientId, role: "OWNER", status: "ACCEPTED" } } },
    });
    await prisma.lawyerClientProfile.create({ data: { userId: lawyerId, acceptingRequests: true, verificationStatus: "VERIFIED", verifiedAt: new Date() } });
    await givePracticeArea([lawyerId]);
    await prisma.lawyerUkRegistration.create({ data: { userId: lawyerId, regulator: "SRA", registrationNumber: "333", qualifiedJurisdictions: ["England and Wales"] } });
    await prisma.case.create({ data: { id: caseId, userId: clientId, organizationId: clientOrgId, caseName: "Unfair dismissal", caseAreas: ["EMPLOYMENT"], ukJurisdiction: "England and Wales" } });
  });

  const cleanWallet = async () => {
    const w = await prisma.wallet.findUnique({ where: { ownerType_ownerId: { ownerType: "ORGANIZATION", ownerId: orgId } } });
    if (!w) return;
    await prisma.walletLedgerEntry.deleteMany({ where: { walletId: w.id } });
    await prisma.earning.deleteMany({ where: { walletId: w.id } });
    await prisma.withdrawal.deleteMany({ where: { walletId: w.id } });
    await prisma.wallet.delete({ where: { id: w.id } });
  };

  const cleanSettings = async () => {
    await prisma.payoutSettings.deleteMany({ where: { tenantId } });
    await redis.del(payoutSettingsCacheKey(tenantId));
  };

  after(async () => {
    await cleanWallet();
    await cleanSettings();
    await prisma.quotationPayment.deleteMany({ where: { clientId } });
    await prisma.clientRequest.deleteMany({ where: { caseId } });
    await prisma.auditEvent.deleteMany({ where: { caseId } });
    await prisma.notification.deleteMany({ where: { userId: { in: [lawyerId, memberId, clientId] } } });
    await prisma.caseAccess.deleteMany({ where: { caseId } });
    await prisma.case.deleteMany({ where: { id: caseId } });
    await prisma.lawyerClientProfile.deleteMany({ where: { userId: lawyerId } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: [lawyerId, memberId, clientId] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, clientOrgId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [lawyerId, memberId, clientId, adminId] } } });
    await prisma.stripeWebhookEvent.deleteMany({ where: { id: { in: webhookEvents } } });
  });

  beforeEach(async () => {
    await cleanWallet();
    await cleanSettings();
    await prisma.quotationPayment.deleteMany({ where: { clientId } });
    await prisma.clientRequest.deleteMany({ where: { caseId } });
    await prisma.caseAccess.deleteMany({ where: { caseId } });
    const now = new Date();
    const row = await prisma.clientRequest.create({
      data: { caseId, clientId, consentVersion: "test", consentAcceptedAt: now, status: "ROUTED", routedAt: now, routingExpiresAt: new Date(now.getTime() + 48 * HOUR_MS) },
    });
    requestId = row.id;
    claimId = (await prisma.clientRequestClaim.create({ data: { requestId, lawyerId, organizationId: orgId, claimedAt: now, expiresAt: new Date(now.getTime() + 24 * HOUR_MS) } })).id;
  });

  afterEach(() => {
    setQuotationPaymentProvider(null);
    setPayoutProvider(null);
  });

  describe("the lawyer's quotation", () => {
    it("prices a draft with the platform fee on top, and keeps it from the client until sent", async () => {
      const { body } = await draft(FIXED_FEE(60000)).expect(200);
      const fee = platformFeeOf(60000, PAYOUT_SETTINGS_DEFAULTS.platformFeeBps, PAYOUT_SETTINGS_DEFAULTS.minPlatformFeeMinor);
      expect(fee).to.equal(9000);
      expect(body.quotation).to.deep.include({ status: "DRAFT", platformFeeBps: 1500 });
      expect(body.quotation.serviceFee).to.deep.equal({ amountMinor: 60000, currency: "GBP" });
      expect(body.quotation.platformFee).to.deep.equal({ amountMinor: 9000, currency: "GBP" });
      expect(body.quotation.total).to.deep.equal({ amountMinor: 69000, currency: "GBP" });
      expect(body.quoteTerms).to.deep.equal({ platformFeeBps: 1500, minPlatformFee: { amountMinor: 500, currency: "GBP" } });
      expect(body.status).to.equal("CLAIMED");
      const client = (await clientView().expect(200)).body;
      expect(client.lawyers[0].quotation).to.equal(null);
      expect(client.status).to.equal("CLAIMED");
    });

    it("never takes less than the minimum platform fee", async () => {
      const { body } = await draft(FIXED_FEE(2000)).expect(200);
      expect(body.quotation.platformFee.amountMinor).to.equal(500);
      expect(body.quotation.total.amountMinor).to.equal(2500);
    });

    it("needs an expiry in the future, and no more than 90 days away", async () => {
      expect((await draft(FIXED_FEE(60000, new Date(Date.now() - HOUR_MS).toISOString())).expect(400)).body.code).to.equal("QUOTATION_EXPIRY_INVALID");
      expect((await draft(FIXED_FEE(60000, inDays(91))).expect(400)).body.code).to.equal("QUOTATION_EXPIRY_INVALID");
      await draft({ ...FIXED_FEE(), expiresAt: undefined }).expect(400);
    });

    it("sends it once: the client sees the fee split, the total and the expiry", async () => {
      const expiresAt = inDays(10);
      await draft(FIXED_FEE(60000, expiresAt)).expect(200);
      const sent = (await send().expect(200)).body;
      expect(sent.status).to.equal("QUOTED");
      expect(sent.quotation.status).to.equal("SENT");
      await send().expect(409);
      await draft(FIXED_FEE(70000)).expect(409);

      const client = (await clientView().expect(200)).body;
      expect(client.status).to.equal("QUOTED");
      expect(client.quotation).to.deep.include({ status: "SENT", expiresAt: new Date(expiresAt).toISOString() });
      expect(client.quotation.total.amountMinor).to.equal(69000);
      expect(client.referralDisclosure).to.include("The lawyer receives their full fee");
      const row = await prisma.clientRequest.findUniqueOrThrow({ where: { id: requestId }, include: { claims: true } });
      expect(row.pickByAt?.toISOString()).to.equal(new Date(expiresAt).toISOString());
      expect(row.claims[0]!.quotedAt).to.be.instanceOf(Date);
    });

    it("keeps the fee it was sent with when an admin changes the rate later", async () => {
      const id = await quoted(FIXED_FEE(60000));
      await request(app).patch("/api/admin/settings/tenants/UK/payout-settings").set(auth(adminId)).send({ platformFeeBps: 2000 }).expect(200);
      const q = await prisma.quotation.findUniqueOrThrow({ where: { id } });
      expect(q).to.deep.include({ platformFeeBps: 1500, platformFeeMinor: 9000, totalAmountMinor: 69000 });
      expect((await lawyerView().expect(200)).body.quoteTerms.platformFeeBps).to.equal(2000);
    });
  });

  describe("accepting and paying", () => {
    it("accepting fixes the total and charges the lawyer nothing", async () => {
      const id = await quoted();
      await accept(id, { disclosureAcknowledged: false }).expect(400);
      const { body } = await accept(id).expect(200);
      expect(body.status).to.equal("CONFIRMED");
      expect(body.awaitingPayment).to.equal(true);
      expect(body.quotation).to.deep.include({ status: "ACCEPTED" });
      expect(body.quotation.acceptedAmount).to.deep.equal({ amountMinor: 69000, currency: "GBP" });
      expect(await prisma.organizationCharge.count({ where: { requestId } })).to.equal(0);
    });

    it("the client pays the total; the lawyer's firm gets the full service fee, PENDING, and access to the case", async () => {
      const id = await quoted();
      await accept(id).expect(200);
      const paid = (await pay(id).expect(200)).body;
      expect(paid.intent).to.equal(null);
      expect(paid.payment).to.deep.include({ status: "SUCCEEDED", provider: "DUMMY" });
      expect(paid.payment.amount.amountMinor).to.equal(69000);
      expect(paid.payment.serviceFee.amountMinor).to.equal(60000);
      expect(paid.payment.platformFee.amountMinor).to.equal(9000);

      const client = (await clientView().expect(200)).body;
      expect(client.status).to.equal("ENGAGED");
      expect(client.quotation.status).to.equal("PAID");
      const access = await prisma.caseAccess.findUnique({ where: { caseId_userId: { caseId, userId: lawyerId } } });
      expect(access?.permission).to.equal("VIEW");

      const w = (await wallet().expect(200)).body;
      expect(w.balances.pending.amountMinor).to.equal(60000);
      expect(w.balances.available.amountMinor).to.equal(0);
      expect(w.minWithdrawal.amountMinor).to.equal(1000);
      const earning = await prisma.earning.findFirstOrThrow({ where: { requestId } });
      expect(earning).to.deep.include({ grossMinor: 69000, platformFeeMinor: 9000, netMinor: 60000, status: "PENDING" });
      expect(earning.availableAt.getTime()).to.be.closeTo(Date.now() + 7 * DAY_MS, 60_000);
    });

    it("a declined payment leaves the request waiting, and the next attempt goes through", async () => {
      const id = await quoted();
      await accept(id).expect(200);
      expect((await pay(id, { testOutcome: "decline" }).expect(402)).body.code).to.equal("PAYMENT_DECLINED");
      expect((await clientView().expect(200)).body.status).to.equal("CONFIRMED");
      await pay(id).expect(200);
      const attempts = await prisma.quotationPayment.findMany({ where: { quotationId: id }, orderBy: { attempt: "asc" } });
      expect(attempts.map((a) => [a.attempt, a.status])).to.deep.equal([
        [1, "FAILED"],
        [2, "SUCCEEDED"],
      ]);
      await pay(id).expect(409);
    });

    it("a free first consultation engages the request on accepting, with nothing to pay", async () => {
      const id = await quoted({ type: "FIRST_CONSULTATION", amount: { amountMinor: 0, currency: "GBP" }, message: "First call is free.", expiresAt: inDays(3) });
      const { body } = await accept(id).expect(200);
      expect(body.status).to.equal("ENGAGED");
      expect(body.quotation.total.amountMinor).to.equal(0);
      expect(await prisma.quotationPayment.count({ where: { quotationId: id } })).to.equal(0);
    });
  });

  describe("with Stripe", () => {
    let stripeNow: Map<string, QuotationPaymentResult>;
    const fake: IntentQuotationPaymentProvider = {
      name: "STRIPE",
      mode: "intent",
      async createIntent(req) {
        return { paymentIntentId: `pi_${req.paymentId}`, clientSecret: `secret_${req.paymentId}`, publishableKey: "pk_test" };
      },
      async resumeIntent(pi) {
        return { paymentIntentId: pi, clientSecret: `secret_${pi}`, publishableKey: "pk_test", status: "PENDING", failureReason: null };
      },
      async status(pi) {
        return stripeNow.get(pi) ?? { status: "PENDING", paymentIntentId: pi, failureReason: null };
      },
      async cancel(pi) {
        return stripeNow.get(pi) ?? { status: "CANCELED", paymentIntentId: pi, failureReason: null };
      },
      async refund(req) {
        return { externalId: `re_${req.refundId}`, status: "SUCCEEDED", failureReason: null };
      },
    };
    const webhook = async (pi: string, paymentId: string) => {
      const id = `evt_${crypto.randomUUID()}`;
      webhookEvents.push(id);
      await ClientBillingSvc.handleStripeEvent({ id, type: "payment_intent.succeeded", data: { object: { id: pi, metadata: { purpose: QUOTATION_PAYMENT_PURPOSE, paymentId } } } } as unknown as Stripe.Event);
    };

    beforeEach(() => {
      stripeNow = new Map();
      setQuotationPaymentProvider(fake);
    });

    it("hands the app a PaymentIntent for the accepted amount, the same one again while it's open, and engages on the webhook once", async () => {
      const id = await quoted();
      await accept(id).expect(200);
      const first = (await pay(id).expect(200)).body;
      expect(first.payment.status).to.equal("PENDING");
      expect(first.intent).to.deep.equal({ clientSecret: `secret_${first.payment.id}`, publishableKey: "pk_test" });
      const again = (await pay(id).expect(200)).body;
      expect(again.payment.id).to.equal(first.payment.id);
      expect((await clientView().expect(200)).body.status).to.equal("CONFIRMED");

      const pi = `pi_${first.payment.id}`;
      stripeNow.set(pi, { status: "SUCCEEDED", paymentIntentId: pi, failureReason: null });
      await webhook(pi, first.payment.id);
      await webhook(pi, first.payment.id);
      expect((await clientView().expect(200)).body.status).to.equal("ENGAGED");
      expect(await prisma.earning.count({ where: { requestId } })).to.equal(1);
      const status = (await request(app).get(`/api/client/lawyer-requests/${requestId}/payment`).set(auth(clientId)).expect(200)).body;
      expect(status.payment.status).to.equal("SUCCEEDED");
    });
  });

  describe("the lawyer's wallet", () => {
    const releaseNow = async () => {
      await prisma.earning.updateMany({ where: { requestId }, data: { availableAt: new Date(Date.now() - 1000) } });
      return WalletSvc.releaseDue();
    };

    it("releases an earning once its hold is over, once", async () => {
      await engaged();
      expect(await WalletSvc.releaseDue()).to.equal(0);
      expect(await releaseNow()).to.equal(1);
      expect(await WalletSvc.releaseDue()).to.equal(0);
      const w = (await wallet().expect(200)).body;
      expect(w.balances.pending.amountMinor).to.equal(0);
      expect(w.balances.available.amountMinor).to.equal(60000);
    });

    it("is the firm's OWNERs' and ADMINs' only", async () => {
      await wallet(memberId).expect(403);
      await withdraw(5000, crypto.randomUUID(), memberId).expect(403);
    });

    it("withdraws once a payout account is set up, within the minimum and the available balance", async () => {
      await engaged();
      await releaseNow();
      expect((await withdraw(20000).expect(409)).body.code).to.equal("PAYOUT_ACCOUNT_REQUIRED");

      const set = (await request(app).post(`/api/organizations/${orgId}/wallet/payout-account/onboarding-link`).set(auth(lawyerId)).send({ returnUrl: "http://localhost:3000/earnings" })).body;
      expect(set.url).to.equal(null);
      expect(set.wallet.payoutAccount).to.deep.include({ connected: true, payoutsEnabled: true });

      expect((await withdraw(500).expect(400)).body.code).to.equal("WITHDRAWAL_BELOW_MINIMUM");
      const tooMuch = (await withdraw(60001).expect(409)).body;
      expect(tooMuch.code).to.equal("INSUFFICIENT_BALANCE");
      expect(tooMuch.available).to.deep.equal({ amountMinor: 60000, currency: "GBP" });

      const key = crypto.randomUUID();
      const paid = (await withdraw(20000, key).expect(201)).body;
      expect(paid).to.deep.include({ status: "PAID" });
      const same = (await withdraw(20000, key).expect(201)).body;
      expect(same.id).to.equal(paid.id);

      const w = (await wallet().expect(200)).body;
      expect(w.balances.available.amountMinor).to.equal(40000);
      expect(w.balances.withdrawn.amountMinor).to.equal(20000);
      expect(w.balances.reserved.amountMinor).to.equal(0);
    });

    it("puts a failed payout back in the available balance", async () => {
      await engaged();
      await releaseNow();
      setPayoutProvider({
        name: "DUMMY",
        mode: "immediate",
        async createAccount(req) {
          return { accountId: `dummy_acct_${req.walletId}`, payoutsEnabled: true, detailsSubmitted: true };
        },
        async payout() {
          return { status: "FAILED", transferId: null, payoutId: null, failureReason: "The bank refused the payout." };
        },
      });
      await request(app).post(`/api/organizations/${orgId}/wallet/payout-account/onboarding-link`).set(auth(lawyerId)).send({ returnUrl: "http://localhost:3000/earnings" }).expect(200);
      const failed = (await withdraw(20000).expect(201)).body;
      expect(failed).to.deep.include({ status: "FAILED", failureReason: "The bank refused the payout." });
      expect((await wallet().expect(200)).body.balances.available.amountMinor).to.equal(60000);
    });
  });

  describe("expiry", () => {
    it("expires a sent quote the client didn't accept in time, ending the lawyer's claim", async () => {
      const id = await quoted();
      await prisma.quotation.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await accept(id).expect(409);
      expect(await QuotationPaymentSvc.expireDue()).to.equal(1);
      const q = await prisma.quotation.findUniqueOrThrow({ where: { id } });
      expect(q.status).to.equal("EXPIRED");
      const claim = await prisma.clientRequestClaim.findUniqueOrThrow({ where: { id: claimId } });
      expect(claim.outcome).to.equal("NOT_CHOSEN");
    });

    it("sends an accepted but unpaid request back to other lawyers at the lawyer's expiry", async () => {
      const id = await quoted();
      await accept(id).expect(200);
      await prisma.quotation.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await pay(id).expect(409)).body.code).to.equal("QUOTATION_EXPIRED");
      expect(await QuotationPaymentSvc.expireDue()).to.equal(1);
      const row = await prisma.clientRequest.findUniqueOrThrow({ where: { id: requestId }, include: { claims: true, quotations: true } });
      expect(row.status).to.equal("ROUTED");
      expect(row.excludedLawyerIds).to.include(lawyerId);
      expect(row.claims[0]!.outcome).to.equal("NOT_CHOSEN");
      expect(row.quotations[0]!.status).to.equal("EXPIRED");
    });
  });

  describe("refunds", () => {
    const refund = (paymentId: string, body: object) => request(app).post(`/api/admin/quotation-payments/${paymentId}/refund`).set(auth(adminId)).send(body);

    it("a partial refund comes out of the lawyer's fee only; a full refund gives back the platform fee too", async () => {
      await engaged();
      const payment = await prisma.quotationPayment.findFirstOrThrow({ where: { requestId, status: "SUCCEEDED" } });
      expect((await refund(payment.id, { amount: { amountMinor: 60001, currency: "GBP" }, reason: "Too much" }).expect(400)).body.code).to.equal("REFUND_EXCEEDS_CHARGE");

      const partial = (await refund(payment.id, { amount: { amountMinor: 10000, currency: "GBP" }, reason: "Part of the work wasn't done" }).expect(200)).body;
      expect(partial.status).to.equal("PARTIALLY_REFUNDED");
      expect((await wallet().expect(200)).body.balances.pending.amountMinor).to.equal(50000);

      const full = (await refund(payment.id, { reason: "Client cancelled" }).expect(200)).body;
      expect(full.status).to.equal("REFUNDED");
      expect(full.refunds.map((r: { amount: { amountMinor: number }; platformFee: { amountMinor: number } }) => [r.amount.amountMinor, r.platformFee.amountMinor])).to.deep.equal([
        [59000, 9000],
        [10000, 0],
      ]);
      expect((await wallet().expect(200)).body.balances.pending.amountMinor).to.equal(0);
      expect((await prisma.earning.findFirstOrThrow({ where: { requestId } })).status).to.equal("REVERSED");
    });
  });

  describe("admin payout settings", () => {
    it("are edited per tenant within limits, and audited", async () => {
      const list = (await request(app).get("/api/admin/settings/payout-settings").set(auth(adminId)).expect(200)).body;
      expect(list.tenants.find((t: { code: string }) => t.code === "UK").settings).to.deep.include({ platformFeeBps: 1500, minWithdrawalMinor: 1000 });
      await request(app).patch("/api/admin/settings/tenants/UK/payout-settings").set(auth(adminId)).send({ platformFeeBps: 9999 }).expect(400);
      await request(app).patch("/api/admin/settings/tenants/UK/payout-settings").set(auth(lawyerId)).send({ minWithdrawalMinor: 2000 }).expect(403);
      const saved = (await request(app).patch("/api/admin/settings/tenants/UK/payout-settings").set(auth(adminId)).send({ minWithdrawalMinor: 2000, earningsHoldDays: 3 }).expect(200)).body;
      expect(saved.settings).to.deep.include({ minWithdrawalMinor: 2000, earningsHoldDays: 3, platformFeeBps: 1500 });
      expect((await wallet().expect(200)).body.minWithdrawal.amountMinor).to.equal(2000);
    });
  });
});
