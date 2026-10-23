/** A lawyer's subscription to a tier through Stripe Checkout (PaymentPlanBillingSvc): checkout,
 * status, and the webhook lifecycle (activation, renewal, failed payment, tier change, cancellation),
 * plus the one webhook dispatch that records an event only after every service applied it
 * (StripeWebhookSvc) and the allowance carry-over on a new period. No live Postgres or Stripe: the
 * repository, the Stripe provider and the Prisma calls are monkeypatched, same idiom as
 * test/client-stripe-checkout.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import type Stripe from "stripe";
import prisma from "../src/lib/prisma";
import * as socket from "../src/lib/socket";
import PaymentPlanBillingSvc from "../src/services/payment-plan-billing.service";
import PaymentPlanStripeSyncSvc from "../src/services/payment-plan-stripe-sync.service";
import StripeWebhookSvc from "../src/services/stripe-webhook.service";
import ClientBillingSvc from "../src/services/client-billing.service";
import AccountTopUpBillingSvc from "../src/services/account-topup-billing.service";
import AccountLimitsSvc from "../src/services/account-limits.service";
import PaymentPlanSubscriptionRepo from "../src/repositories/payment-plan-subscription.repository";
import ClientPaymentRepo from "../src/repositories/client-payment.repository";
import * as provider from "../src/payments/payment-plan-subscription-provider";

function stash(target: object, keys: string[]) {
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

const event = (id: string, type: string, object: Record<string, unknown>) => ({ id, type, data: { object } }) as unknown as Stripe.Event;

const PERIOD_START = 1_790_000_000;
const PERIOD_END = PERIOD_START + 30 * 24 * 3600;

function stripeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    status: "active",
    cancel_at_period_end: false,
    latest_invoice: "in_first",
    items: { data: [{ current_period_start: PERIOD_START, current_period_end: PERIOD_END, price: { id: "price_pro", product: "prod_pro" } }] },
    ...overrides,
  };
}

const PLANS: Record<string, any> = {
  standard: { id: "plan-standard", tenantId: "t-uk", code: "standard", isActive: true },
  pro: { id: "plan-pro", tenantId: "t-uk", code: "pro", isActive: true },
};

describe("PaymentPlanBillingSvc", () => {
  let restore: (() => void)[];
  let rows: Map<string, any>;
  let calls: { method: string; args: unknown[] }[];
  let checkoutRequests: provider.PaymentPlanCheckoutRequest[];
  let expiredSessions: string[];
  let session: Record<string, unknown>;
  let notifications: { userId: string; title: string }[];
  let user: Record<string, unknown> | null;

  const record =
    (method: string, result?: (...args: any[]) => unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return result ? result(...args) : true;
    };

  beforeEach(() => {
    rows = new Map();
    calls = [];
    checkoutRequests = [];
    expiredSessions = [];
    notifications = [];
    session = { id: "cs_1", status: "open", payment_status: "unpaid", client_secret: "cs_secret_1", subscription: null };
    user = { role: "LAWYER", tenantId: "t-uk", email: "lawyer@example.com", paymentPlan: { code: "standard" } };

    restore = [
      stash(PaymentPlanSubscriptionRepo, ["create", "setCheckoutSession", "findById", "findForUser", "findByStripeSubscriptionId", "findOpenForUser", "findLiveForUser", "expire", "activate", "rollPeriod", "markPastDue", "sync", "cancel"]),
      stash(provider, ["createPaymentPlanCheckout", "paymentPlanCheckoutSession", "expirePaymentPlanCheckout", "retrievePaymentPlanSubscription"]),
      stash(PaymentPlanStripeSyncSvc, ["ensureStripePrice"]),
      stash(prisma.user, ["findUnique"]),
      stash(prisma.paymentPlan, ["findUnique", "findMany", "findFirst"]),
      stash(prisma.notification, ["create"]),
      stash(socket, ["emitToUser"]),
    ];

    const repo = PaymentPlanSubscriptionRepo as any;
    repo.create = async (data: any) => {
      const row = { id: `sub-row-${rows.size + 1}`, status: "PENDING", checkoutSessionId: null, stripeSubscriptionId: null, ...data };
      rows.set(row.id, row);
      return row;
    };
    repo.setCheckoutSession = async (id: string, checkoutSessionId: string) => void (rows.get(id).checkoutSessionId = checkoutSessionId);
    repo.findById = async (id: string) => rows.get(id) ?? null;
    repo.findForUser = async (id: string, userId: string) => {
      const row = rows.get(id);
      return row && row.userId === userId ? { ...row, paymentPlan: { code: Object.values(PLANS).find((p) => p.id === row.paymentPlanId)?.code } } : null;
    };
    repo.findByStripeSubscriptionId = async (id: string) => [...rows.values()].find((r) => r.stripeSubscriptionId === id) ?? null;
    repo.findOpenForUser = async (userId: string) => [...rows.values()].reverse().find((r) => r.userId === userId && r.status === "PENDING" && r.checkoutSessionId) ?? null;
    repo.findLiveForUser = async (userId: string) => [...rows.values()].find((r) => r.userId === userId && ["ACTIVE", "PAST_DUE"].includes(r.status)) ?? null;
    repo.expire = record("expire", (id: string, reason: string) => {
      const row = rows.get(id);
      if (row?.status !== "PENDING") return false;
      Object.assign(row, { status: "EXPIRED", failureReason: reason });
      return true;
    });
    repo.activate = record("activate", (id: string, stripeSubscriptionId: string) => {
      const row = rows.get(id);
      if (row?.status !== "PENDING") return false;
      Object.assign(row, { status: "ACTIVE", stripeSubscriptionId });
      return true;
    });
    repo.rollPeriod = record("rollPeriod");
    repo.markPastDue = record("markPastDue", (id: string) => {
      const row = rows.get(id);
      if (row?.status !== "ACTIVE") return false;
      row.status = "PAST_DUE";
      return true;
    });
    repo.sync = record("sync");
    repo.cancel = record("cancel", (id: string) => {
      const row = rows.get(id);
      if (!["ACTIVE", "PAST_DUE"].includes(row?.status)) return false;
      row.status = "CANCELED";
      return true;
    });

    const p = provider as any;
    p.createPaymentPlanCheckout = async (request: provider.PaymentPlanCheckoutRequest) => {
      checkoutRequests.push(request);
      return { externalId: `cs_${request.subscriptionId}`, clientSecret: `secret_${request.subscriptionId}`, publishableKey: "pk_test_123" };
    };
    p.paymentPlanCheckoutSession = async (id: string) => ({ ...session, id });
    p.expirePaymentPlanCheckout = async (id: string) => void expiredSessions.push(id);
    p.retrievePaymentPlanSubscription = async () => stripeSubscription();
    (PaymentPlanStripeSyncSvc as any).ensureStripePrice = async (plan: any) => `price_${plan.code}`;

    (prisma.user as any).findUnique = async () => user;
    (prisma.paymentPlan as any).findUnique = async ({ where }: any) => PLANS[where.tenantId_planType_code.code] ?? null;
    (prisma.paymentPlan as any).findMany = async () => Object.values(PLANS);
    (prisma.paymentPlan as any).findFirst = async () => ({ id: "plan-pro" });
    (prisma.notification as any).create = async ({ data }: any) => {
      notifications.push(data);
      return data;
    };
    (socket as any).emitToUser = () => undefined;
  });

  afterEach(() => restore.forEach((r) => r()));

  describe("startCheckout", () => {
    it("opens a subscription checkout for the tier, on its Stripe Price", async () => {
      const result = await PaymentPlanBillingSvc.startCheckout("u1", "pro", "http://uk.localhost:3002");
      expect(result).to.deep.include({ subscriptionId: "sub-row-1", status: "PENDING", planCode: "pro" });
      expect(result.checkout).to.deep.equal({ provider: "STRIPE", clientSecret: "secret_sub-row-1", publishableKey: "pk_test_123" });
      expect(checkoutRequests[0]).to.include({ subscriptionId: "sub-row-1", userId: "u1", paymentPlanId: "plan-pro", stripePriceId: "price_pro", customerEmail: "lawyer@example.com" });
      expect(rows.get("sub-row-1").checkoutSessionId).to.equal("cs_sub-row-1");
    });

    it("refuses a second plan while one is live", async () => {
      rows.set("live", { id: "live", userId: "u1", status: "ACTIVE", paymentPlanId: "plan-standard" });
      expect(await errorOf(PaymentPlanBillingSvc.startCheckout("u1", "pro", undefined))).to.deep.equal({ status: 409, code: "ALREADY_SUBSCRIBED" });
      expect(checkoutRequests).to.be.empty;
    });

    it("settles a checkout that was paid but not settled yet, instead of opening a second one", async () => {
      await PaymentPlanBillingSvc.startCheckout("u1", "pro", undefined);
      session = { status: "complete", payment_status: "paid", subscription: stripeSubscription() };
      expect(await errorOf(PaymentPlanBillingSvc.startCheckout("u1", "pro", undefined))).to.deep.equal({ status: 409, code: "ALREADY_SUBSCRIBED" });
      expect(rows.get("sub-row-1").status).to.equal("ACTIVE");
      expect(checkoutRequests).to.have.length(1);
    });

    it("reuses the open checkout for the same tier", async () => {
      await PaymentPlanBillingSvc.startCheckout("u1", "pro", undefined);
      const again = await PaymentPlanBillingSvc.startCheckout("u1", "pro", undefined);
      expect(again.subscriptionId).to.equal("sub-row-1");
      expect(checkoutRequests).to.have.length(1);
    });

    it("closes an open checkout for another tier, so two can never both be paid", async () => {
      await PaymentPlanBillingSvc.startCheckout("u1", "standard", undefined);
      const pro = await PaymentPlanBillingSvc.startCheckout("u1", "pro", undefined);
      expect(expiredSessions).to.deep.equal(["cs_sub-row-1"]);
      expect(rows.get("sub-row-1").status).to.equal("EXPIRED");
      expect(pro.subscriptionId).to.equal("sub-row-2");
    });

    it("refuses an unknown or hidden tier, and a non-lawyer", async () => {
      expect(await errorOf(PaymentPlanBillingSvc.startCheckout("u1", "gold", undefined))).to.deep.include({ status: 404 });
      user = { role: "USER", tenantId: "t-uk" };
      expect(await errorOf(PaymentPlanBillingSvc.startCheckout("u1", "pro", undefined))).to.deep.include({ status: 403 });
    });

    it("expires the row when Stripe can't open the checkout", async () => {
      (provider as any).createPaymentPlanCheckout = async () => {
        throw new Error("Stripe is down");
      };
      expect(await errorOf(PaymentPlanBillingSvc.startCheckout("u1", "pro", undefined))).to.deep.equal({ status: 502, code: "PAYMENT_PROVIDER_ERROR" });
      expect(rows.get("sub-row-1").status).to.equal("EXPIRED");
    });
  });

  describe("status", () => {
    it("activates a paid checkout with the subscription's period and first invoice", async () => {
      await PaymentPlanBillingSvc.startCheckout("u1", "pro", undefined);
      session = { status: "complete", payment_status: "paid", subscription: stripeSubscription() };
      expect(await PaymentPlanBillingSvc.status("u1", "sub-row-1")).to.deep.include({ status: "ACTIVE", planCode: "pro" });
      const activate = calls.find((c) => c.method === "activate")!;
      expect(activate.args).to.deep.equal([
        "sub-row-1",
        "sub_1",
        { currentPeriodStart: new Date(PERIOD_START * 1000), currentPeriodEnd: new Date(PERIOD_END * 1000), cancelAtPeriodEnd: false },
        "in_first",
      ]);
    });

    it("expires an abandoned checkout, and leaves an open one PENDING", async () => {
      await PaymentPlanBillingSvc.startCheckout("u1", "pro", undefined);
      expect((await PaymentPlanBillingSvc.status("u1", "sub-row-1")).status).to.equal("PENDING");
      session = { status: "expired", payment_status: "unpaid" };
      expect((await PaymentPlanBillingSvc.status("u1", "sub-row-1")).status).to.equal("EXPIRED");
    });

    it("answers 404 for another lawyer's subscription", async () => {
      await PaymentPlanBillingSvc.startCheckout("u1", "pro", undefined);
      expect(await errorOf(PaymentPlanBillingSvc.status("u2", "sub-row-1"))).to.deep.include({ status: 404 });
    });
  });

  describe("handleStripeEvent (the webhook)", () => {
    const ours = (extra: Record<string, unknown> = {}) => ({ id: "cs_sub-row-1", mode: "subscription", metadata: { kind: provider.PAYMENT_PLAN_METADATA_KIND, subscriptionId: "sub-row-1" }, ...extra });
    const invoice = (billing_reason: string, id = "in_2") => ({ id, billing_reason, parent: { subscription_details: { subscription: "sub_1" } } });

    async function activeSubscription() {
      await PaymentPlanBillingSvc.startCheckout("u1", "pro", undefined);
      session = { status: "complete", payment_status: "paid", subscription: stripeSubscription() };
      await PaymentPlanBillingSvc.handleStripeEvent(event("evt_0", "checkout.session.completed", ours()));
      calls = [];
    }

    it("activates on checkout.session.completed", async () => {
      await activeSubscription();
      expect(rows.get("sub-row-1")).to.include({ status: "ACTIVE", stripeSubscriptionId: "sub_1" });
    });

    it("ignores a checkout that isn't a subscription of ours", async () => {
      expect(await PaymentPlanBillingSvc.handleStripeEvent(event("evt_1", "checkout.session.completed", { id: "cs_x", metadata: { kind: "ACCOUNT_TOPUP" } }))).to.deep.equal({ handled: false });
      await PaymentPlanBillingSvc.startCheckout("u1", "pro", undefined);
      await PaymentPlanBillingSvc.handleStripeEvent(event("evt_2", "checkout.session.completed", ours({ id: "cs_from_another_env" })));
      expect(rows.get("sub-row-1").status).to.equal("PENDING");
    });

    it("expires on checkout.session.expired", async () => {
      await PaymentPlanBillingSvc.startCheckout("u1", "pro", undefined);
      await PaymentPlanBillingSvc.handleStripeEvent(event("evt_1", "checkout.session.expired", ours()));
      expect(rows.get("sub-row-1").status).to.equal("EXPIRED");
    });

    it("starts a new allowance period on a paid renewal, and only on a renewal", async () => {
      await activeSubscription();
      await PaymentPlanBillingSvc.handleStripeEvent(event("evt_1", "invoice.paid", invoice("subscription_create", "in_first")));
      await PaymentPlanBillingSvc.handleStripeEvent(event("evt_2", "invoice.paid", invoice("subscription_update", "in_proration")));
      expect(calls.filter((c) => c.method === "rollPeriod")).to.be.empty;
      await PaymentPlanBillingSvc.handleStripeEvent(event("evt_3", "invoice.paid", invoice("subscription_cycle", "in_2")));
      const roll = calls.find((c) => c.method === "rollPeriod")!;
      expect(roll.args.slice(0, 2)).to.deep.equal(["sub-row-1", "in_2"]);
    });

    it("marks a failed renewal PAST_DUE and tells the lawyer once, not on every retry", async () => {
      await activeSubscription();
      await PaymentPlanBillingSvc.handleStripeEvent(event("evt_1", "invoice.payment_failed", invoice("subscription_cycle")));
      await PaymentPlanBillingSvc.handleStripeEvent(event("evt_2", "invoice.payment_failed", invoice("subscription_cycle")));
      expect(rows.get("sub-row-1").status).to.equal("PAST_DUE");
      expect(notifications.map((n) => n.userId)).to.deep.equal(["u1"]);
    });

    it("syncs a subscription change from Stripe, tier included", async () => {
      await activeSubscription();
      await PaymentPlanBillingSvc.handleStripeEvent(event("evt_1", "customer.subscription.updated", stripeSubscription({ status: "past_due", cancel_at_period_end: true })));
      const sync = calls.find((c) => c.method === "sync")!;
      expect(sync.args[1]).to.deep.include({ status: "PAST_DUE", paymentPlanId: "plan-pro", cancelAtPeriodEnd: true });
    });

    it("cancels on customer.subscription.deleted and tells the lawyer the account is read-only", async () => {
      await activeSubscription();
      await PaymentPlanBillingSvc.handleStripeEvent(event("evt_1", "customer.subscription.deleted", stripeSubscription({ status: "canceled" })));
      await PaymentPlanBillingSvc.handleStripeEvent(event("evt_2", "customer.subscription.deleted", stripeSubscription({ status: "canceled" })));
      expect(rows.get("sub-row-1").status).to.equal("CANCELED");
      expect(notifications).to.have.length(1);
    });

    it("ignores invoices and subscriptions that aren't ours", async () => {
      expect(await PaymentPlanBillingSvc.handleStripeEvent(event("evt_1", "invoice.paid", invoice("subscription_cycle")))).to.deep.equal({ handled: false });
      expect(await PaymentPlanBillingSvc.handleStripeEvent(event("evt_2", "customer.subscription.deleted", stripeSubscription({ id: "sub_other" })))).to.deep.equal({ handled: false });
    });
  });
});

describe("StripeWebhookSvc", () => {
  let restore: (() => void)[];
  let recorded: Set<string>;
  let ran: string[];

  beforeEach(() => {
    recorded = new Set();
    ran = [];
    restore = [
      stash(ClientPaymentRepo, ["isWebhookEventRecorded", "recordWebhookEvent"]),
      stash(ClientBillingSvc, ["handleStripeEvent"]),
      stash(AccountTopUpBillingSvc, ["handleStripeEvent"]),
      stash(PaymentPlanBillingSvc, ["handleStripeEvent"]),
    ];
    (ClientPaymentRepo as any).isWebhookEventRecorded = async (id: string) => recorded.has(id);
    (ClientPaymentRepo as any).recordWebhookEvent = async (id: string) => recorded.add(id);
    (ClientBillingSvc as any).handleStripeEvent = async () => void ran.push("client");
    (AccountTopUpBillingSvc as any).handleStripeEvent = async () => void ran.push("topup");
    (PaymentPlanBillingSvc as any).handleStripeEvent = async () => void ran.push("plan");
  });

  afterEach(() => restore.forEach((r) => r()));

  it("runs every billing service, then records the event", async () => {
    expect(await StripeWebhookSvc.handle(event("evt_1", "invoice.paid", {}))).to.deep.equal({ duplicate: false });
    expect(ran).to.deep.equal(["client", "topup", "plan"]);
    expect(recorded.has("evt_1")).to.equal(true);
  });

  it("answers a retried delivery as a duplicate without running anything", async () => {
    recorded.add("evt_1");
    expect(await StripeWebhookSvc.handle(event("evt_1", "invoice.paid", {}))).to.deep.equal({ duplicate: true });
    expect(ran).to.be.empty;
  });

  it("records nothing when a service fails, so Stripe's retry runs them all again", async () => {
    (PaymentPlanBillingSvc as any).handleStripeEvent = async () => {
      throw new Error("database blip");
    };
    expect(await errorOf(StripeWebhookSvc.handle(event("evt_1", "invoice.paid", {})))).to.not.equal(undefined);
    expect(recorded.has("evt_1")).to.equal(false);
  });
});

describe("AccountLimitsSvc.startAllowancePeriod", () => {
  const db = (opts: { extra: number; included: number | null; spent: number }) => {
    const updates: any[] = [];
    return {
      updates,
      client: {
        user: {
          findUniqueOrThrow: async () => ({ extraAiAllowanceUsd: opts.extra, allowancePeriodStart: null, paymentPlan: opts.included === null ? null : { includedAllowanceUsd: opts.included } }),
          update: async (args: any) => void updates.push(args.data),
        },
        llmUsage: { aggregate: async () => ({ _sum: { estimatedCostUsd: opts.spent } }) },
      } as never,
    };
  };
  const start = new Date("2026-11-01T00:00:00Z");

  it("moves the lawyer onto the tier and starts the period", async () => {
    const { client, updates } = db({ extra: 0, included: 10, spent: 4 });
    await AccountLimitsSvc.startAllowancePeriod("u1", "plan-pro", start, client);
    expect(updates[0]).to.deep.equal({ paymentPlanId: "plan-pro", allowancePeriodStart: start, extraAiAllowanceUsd: 0 });
  });

  it("keeps all paid top-up credit when the tier's own allowance covered the spend", async () => {
    const { client, updates } = db({ extra: 20, included: 10, spent: 8 });
    await AccountLimitsSvc.startAllowancePeriod("u1", "plan-pro", start, client);
    expect(updates[0].extraAiAllowanceUsd).to.equal(20);
  });

  it("carries over only the top-up credit the ending period didn't use", async () => {
    const { client, updates } = db({ extra: 20, included: 10, spent: 25 });
    await AccountLimitsSvc.startAllowancePeriod("u1", "plan-pro", start, client);
    expect(updates[0].extraAiAllowanceUsd).to.equal(5);
  });

  it("never goes below zero", async () => {
    const { client, updates } = db({ extra: 5, included: 10, spent: 40 });
    await AccountLimitsSvc.startAllowancePeriod("u1", "plan-pro", start, client);
    expect(updates[0].extraAiAllowanceUsd).to.equal(0);
  });
});
