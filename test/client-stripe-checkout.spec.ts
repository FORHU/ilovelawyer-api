/** Client app payments through Stripe Checkout (ilovelawyer-api#537): a payment starts PENDING with
 * an embedded checkout, settles once on the webhook or when the app asks, a retried webhook is never
 * applied twice, and a forged one is refused. Stripe itself is replaced by a fake provider; webhook
 * signatures use the real Stripe library with a test secret. No live Postgres: the repository is
 * monkeypatched, same idiom as test/client-billing.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import Stripe from "stripe";
import ClientBillingSvc, { returnOrigin } from "../src/services/client-billing.service";
import ClientPaymentRepo from "../src/repositories/client-payment.repository";
import {
  outcomeOfSession,
  setClientPaymentProvider,
  type CheckoutClientPaymentProvider,
  type CheckoutOutcome,
  type ClientCheckoutRequest,
} from "../src/payments/client-payment-provider";
import { verifyStripeWebhook } from "../src/payments/stripe-client";
import { CLIENT_CASE_CREDITS, CLIENT_CASE_PRICE_MINOR } from "../src/constants/client-pricing.constants";
import { CLIENT_URL, USER_APP_URL } from "../src/config";

function stash<T extends object>(target: T, keys: string[]) {
  const saved = keys.map((k) => [k, (target as any)[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

async function errorOf(promise: Promise<unknown>): Promise<{ status?: number; code?: string } | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err: any) {
    return { status: err.statusCode, code: err.code };
  }
}

function sessionEvent(id: string, type: string, session: Record<string, unknown>): Stripe.Event {
  return { id, type, data: { object: session } } as unknown as Stripe.Event;
}

describe("Client app payments through Stripe Checkout", () => {
  let restore: () => void;
  let payments: Map<string, any>;
  let credits: Record<string, number>;
  let recordedEvents: Set<string>;
  let checkoutRequests: ClientCheckoutRequest[];
  let outcome: CheckoutOutcome | Error;
  let createFails: boolean;

  const fakeStripe: CheckoutClientPaymentProvider = {
    name: "STRIPE",
    mode: "checkout",
    async createCheckout(request) {
      checkoutRequests.push(request);
      if (createFails) throw new Error("Stripe is down");
      return { externalId: `cs_test_${request.paymentId}`, clientSecret: `cs_secret_${request.paymentId}`, publishableKey: "pk_test_123" };
    },
    async checkoutOutcome() {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };

  const savedUserAppUrl = [...USER_APP_URL];
  const savedClientUrl = [...CLIENT_URL];

  beforeEach(() => {
    restore = stash(ClientPaymentRepo, [
      "create",
      "hasPaidForCase",
      "addCredits",
      "creditsOf",
      "setExternalId",
      "findForUser",
      "findById",
      "findEmail",
      "settle",
      "recordWebhookEvent",
      "isWebhookEventRecorded",
    ]);
    payments = new Map();
    credits = { "case-1": 3 };
    recordedEvents = new Set();
    checkoutRequests = [];
    outcome = "open";
    createFails = false;
    USER_APP_URL.splice(0, USER_APP_URL.length, "https://app.example.com", "https://ilovelawyer.example.com");
    CLIENT_URL.splice(0, CLIENT_URL.length, "http://localhost:3004");

    const repo = ClientPaymentRepo as any;
    repo.create = async (data: any) => {
      const row = { id: `pay-${payments.size + 1}`, usedAt: null, createdAt: new Date(), ...data };
      payments.set(row.id, row);
      return { ...row };
    };
    repo.hasPaidForCase = async () => false;
    repo.addCredits = async (caseId: string, n: number) => (credits[caseId] = (credits[caseId] ?? 0) + n);
    repo.creditsOf = async (caseId: string) => credits[caseId] ?? 0;
    repo.setExternalId = async (id: string, externalId: string) => {
      payments.get(id).externalId = externalId;
    };
    repo.findForUser = async (id: string, userId: string) => {
      const p = payments.get(id);
      return p && p.userId === userId ? { ...p } : null;
    };
    repo.findById = async (id: string) => (payments.has(id) ? { ...payments.get(id) } : null);
    repo.findEmail = async () => "client@example.com";
    // The real settle is one conditional update: only a PENDING payment moves, once.
    repo.settle = async (id: string, result: { paid: boolean; reason?: string }) => {
      const p = payments.get(id);
      if (!p || p.status !== "PENDING") return false;
      p.status = result.paid ? "SUCCEEDED" : "FAILED";
      if (!result.paid) p.failureReason = result.reason;
      if (result.paid && p.kind === "TOP_UP" && p.caseId) credits[p.caseId] = (credits[p.caseId] ?? 0) + p.credits;
      return true;
    };
    repo.recordWebhookEvent = async (id: string) => {
      if (recordedEvents.has(id)) return false;
      recordedEvents.add(id);
      return true;
    };
    repo.isWebhookEventRecorded = async (id: string) => recordedEvents.has(id);
    setClientPaymentProvider(fakeStripe);
  });

  afterEach(() => {
    restore();
    setClientPaymentProvider(null);
    USER_APP_URL.splice(0, USER_APP_URL.length, ...savedUserAppUrl);
    CLIENT_URL.splice(0, CLIENT_URL.length, ...savedClientUrl);
  });

  describe("starting a payment", () => {
    it("opens an embedded checkout and keeps the case payment PENDING until Stripe says it's paid", async () => {
      const started = await ClientBillingSvc.payForCase("u1", { promoCode: "WELCOME5", origin: "https://ilovelawyer.example.com" });
      expect(started).to.deep.equal({
        paymentId: "pay-1",
        status: "PENDING",
        amount: { amountMinor: CLIENT_CASE_PRICE_MINOR - 500, currency: "USD" },
        credits: CLIENT_CASE_CREDITS,
        checkout: { provider: "STRIPE", clientSecret: "cs_secret_pay-1", publishableKey: "pk_test_123" },
      });
      expect(payments.get("pay-1")).to.include({ provider: "STRIPE", status: "PENDING", externalId: "cs_test_pay-1" });
      expect(checkoutRequests[0]).to.include({
        paymentId: "pay-1",
        userId: "u1",
        customerEmail: "client@example.com",
        amountMinor: CLIENT_CASE_PRICE_MINOR - 500,
        returnUrl: "https://ilovelawyer.example.com/payments/return?paymentId=pay-1",
      });
    });

    it("adds a top-up's credits only once it's paid", async () => {
      const started = await ClientBillingSvc.topUp("u1", "case-1", { packId: "p25" });
      expect(started).to.include({ status: "PENDING", credits: 3, added: 25 });
      expect(started.checkout).to.include({ clientSecret: "cs_secret_pay-1" });
      expect(credits["case-1"]).to.equal(3);
    });

    it("fails the payment and says so when the checkout can't be opened", async () => {
      createFails = true;
      expect(await errorOf(ClientBillingSvc.payForCase("u1", {}))).to.deep.equal({ status: 502, code: "PAYMENT_PROVIDER_ERROR" });
      expect(payments.get("pay-1")).to.include({ status: "FAILED" });
    });

    it("ignores the dummy's decline switch: Stripe's own test cards do that", async () => {
      const started = await ClientBillingSvc.payForCase("u1", { testOutcome: "decline" });
      expect(started.status).to.equal("PENDING");
    });
  });

  describe("returnOrigin", () => {
    it("sends the client back where they came from when it's a known app origin, else the first USER_APP_URL", () => {
      expect(returnOrigin("https://ilovelawyer.example.com/")).to.equal("https://ilovelawyer.example.com");
      expect(returnOrigin("http://localhost:3004")).to.equal("http://localhost:3004");
      expect(returnOrigin("https://evil.example.com")).to.equal("https://app.example.com");
      expect(returnOrigin(undefined)).to.equal("https://app.example.com");
    });
  });

  describe("paymentStatus (the app asking after the client paid)", () => {
    it("settles a paid checkout at once, without waiting for the webhook", async () => {
      await ClientBillingSvc.payForCase("u1", {});
      outcome = "paid";
      expect(await ClientBillingSvc.paymentStatus("u1", "pay-1")).to.include({ status: "SUCCEEDED", usable: true });
    });

    it("fails an expired checkout, and leaves one still open alone", async () => {
      await ClientBillingSvc.payForCase("u1", {});
      expect(await ClientBillingSvc.paymentStatus("u1", "pay-1")).to.include({ status: "PENDING", usable: false });
      outcome = "expired";
      const after = await ClientBillingSvc.paymentStatus("u1", "pay-1");
      expect(after).to.include({ status: "FAILED" });
      expect(after.failureReason).to.match(/expired/);
    });

    it("leaves the payment PENDING when Stripe can't be reached", async () => {
      await ClientBillingSvc.payForCase("u1", {});
      outcome = new Error("timeout");
      expect(await ClientBillingSvc.paymentStatus("u1", "pay-1")).to.include({ status: "PENDING" });
    });

    it("answers 404 for another client's payment", async () => {
      await ClientBillingSvc.payForCase("u1", {});
      expect(await errorOf(ClientBillingSvc.paymentStatus("u2", "pay-1"))).to.deep.include({ status: 404 });
    });
  });

  describe("handleStripeEvent (the webhook)", () => {
    const completed = (paymentId: string, extra: Record<string, unknown> = {}) => ({
      id: `cs_test_${paymentId}`,
      status: "complete",
      payment_status: "paid",
      metadata: { paymentId },
      client_reference_id: paymentId,
      ...extra,
    });

    it("settles a paid checkout, and adds a top-up's credits", async () => {
      await ClientBillingSvc.topUp("u1", "case-1", { packId: "p25" });
      await ClientBillingSvc.handleStripeEvent(sessionEvent("evt_1", "checkout.session.completed", completed("pay-1")));
      expect(payments.get("pay-1").status).to.equal("SUCCEEDED");
      expect(credits["case-1"]).to.equal(28);
    });

    it("applies a retried delivery only once", async () => {
      await ClientBillingSvc.topUp("u1", "case-1", { packId: "p25" });
      const event = sessionEvent("evt_1", "checkout.session.completed", completed("pay-1"));
      await ClientBillingSvc.handleStripeEvent(event);
      expect(await ClientBillingSvc.handleStripeEvent(event)).to.deep.equal({ duplicate: true });
      expect(credits["case-1"]).to.equal(28);
    });

    it("never pays twice when the webhook and the app both settle the same payment", async () => {
      await ClientBillingSvc.topUp("u1", "case-1", { packId: "p25" });
      outcome = "paid";
      await ClientBillingSvc.paymentStatus("u1", "pay-1");
      await ClientBillingSvc.handleStripeEvent(sessionEvent("evt_1", "checkout.session.completed", completed("pay-1")));
      expect(credits["case-1"]).to.equal(28);
    });

    it("waits on a completed checkout whose bank payment is still clearing, then settles on its outcome", async () => {
      await ClientBillingSvc.payForCase("u1", {});
      await ClientBillingSvc.handleStripeEvent(sessionEvent("evt_1", "checkout.session.completed", completed("pay-1", { payment_status: "unpaid" })));
      expect(payments.get("pay-1").status).to.equal("PENDING");
      await ClientBillingSvc.handleStripeEvent(sessionEvent("evt_2", "checkout.session.async_payment_failed", completed("pay-1", { payment_status: "unpaid" })));
      expect(payments.get("pay-1").status).to.equal("FAILED");
    });

    it("fails an expired checkout", async () => {
      await ClientBillingSvc.payForCase("u1", {});
      await ClientBillingSvc.handleStripeEvent(sessionEvent("evt_1", "checkout.session.expired", completed("pay-1", { status: "expired", payment_status: "unpaid" })));
      expect(payments.get("pay-1")).to.include({ status: "FAILED" });
    });

    it("ignores a session that isn't one of ours, or doesn't match the payment it names", async () => {
      await ClientBillingSvc.payForCase("u1", {});
      await ClientBillingSvc.handleStripeEvent(sessionEvent("evt_1", "checkout.session.completed", completed("pay-from-another-env")));
      await ClientBillingSvc.handleStripeEvent(sessionEvent("evt_2", "checkout.session.completed", completed("pay-1", { id: "cs_test_other" })));
      expect(payments.get("pay-1").status).to.equal("PENDING");
      expect(recordedEvents).to.deep.equal(new Set(["evt_1", "evt_2"]));
    });

    it("acknowledges events it doesn't handle", async () => {
      expect(await ClientBillingSvc.handleStripeEvent(sessionEvent("evt_1", "customer.created", {}))).to.deep.equal({ duplicate: false });
    });
  });

  describe("outcomeOfSession", () => {
    it("reads Stripe's session state", () => {
      expect(outcomeOfSession({ status: "complete", payment_status: "paid" })).to.equal("paid");
      expect(outcomeOfSession({ status: "complete", payment_status: "unpaid" })).to.equal("open");
      expect(outcomeOfSession({ status: "open", payment_status: "unpaid" })).to.equal("open");
      expect(outcomeOfSession({ status: "expired", payment_status: "unpaid" })).to.equal("expired");
    });
  });

  describe("verifyStripeWebhook", () => {
    const secret = "whsec_test_secret";
    const payload = JSON.stringify({ id: "evt_1", object: "event", type: "checkout.session.completed", data: { object: {} } });

    it("accepts a delivery signed with our secret", () => {
      const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
      expect(verifyStripeWebhook(Buffer.from(payload), header, secret).id).to.equal("evt_1");
    });

    it("refuses a forged or tampered delivery with a 400", () => {
      const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_someone_else" });
      expect(() => verifyStripeWebhook(Buffer.from(payload), header, secret)).to.throw().with.property("code", "STRIPE_SIGNATURE_INVALID");
      const good = Stripe.webhooks.generateTestHeaderString({ payload, secret });
      expect(() => verifyStripeWebhook(Buffer.from(payload.replace("evt_1", "evt_2")), good, secret)).to.throw().with.property("statusCode", 400);
      expect(() => verifyStripeWebhook(Buffer.from(payload), undefined, secret)).to.throw().with.property("statusCode", 400);
    });
  });
});
