/** A lawyer who already pays changing tier (PaymentPlanBillingSvc.previewChange/changePlan): an
 * upgrade charges the prorated difference now and moves them at once, a downgrade is scheduled for the
 * end of the paid period, and choosing their own tier again keeps it. Against the real local Postgres;
 * the Stripe calls are stubbed. */
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import crypto from "crypto";
import prisma from "../src/lib/prisma";
import * as socket from "../src/lib/socket";
import HttpError from "../src/utils/http-error";
import PaymentPlanBillingSvc from "../src/services/payment-plan-billing.service";
import PaymentPlanStripeSyncSvc from "../src/services/payment-plan-stripe-sync.service";
import PaymentPlanSubscriptionRepo from "../src/repositories/payment-plan-subscription.repository";
import * as provider from "../src/payments/payment-plan-subscription-provider";

async function errorOf(promise: Promise<unknown>): Promise<{ status?: number; code?: string } | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err: any) {
    return { status: err.statusCode, code: err.code };
  }
}

function stash(target: object, keys: string[]) {
  const saved = keys.map((k) => [k, (target as any)[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

const PERIOD_START = new Date("2026-11-01T00:00:00Z");
const PERIOD_END = new Date("2026-12-01T00:00:00Z");

describe("Changing a paid plan", () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const users: string[] = [];
  const plans: Record<string, { id: string }> = {};
  let calls: { method: string; args: unknown[] }[];
  /** The Stripe subscription as the stub currently has it: its one item's Price and schedule. */
  let stripe: { price: string; schedule: string | null };
  let restore: () => void;

  const subscription = () => ({
    id: `sub_${tag}`,
    status: "active",
    cancel_at_period_end: false,
    schedule: stripe.schedule,
    items: { data: [{ id: "si_1", price: { id: stripe.price }, current_period_start: PERIOD_START.getTime() / 1000, current_period_end: PERIOD_END.getTime() / 1000 }] },
  });

  /** A lawyer paying for `code` through a live Stripe subscription. */
  async function subscriber(code: string) {
    const id = crypto.randomUUID();
    users.push(id);
    await prisma.user.create({
      data: { id, email: `change-${tag}-${users.length}@example.com`, username: `change-${tag}-${users.length}`, role: "LAWYER", tenantId: (await ukTenant()).id, paymentPlanId: plans[code].id, approvalStatus: "ACTIVE" },
    });
    const row = await prisma.paymentPlanSubscription.create({
      data: { userId: id, paymentPlanId: plans[code].id, provider: "STRIPE", status: "ACTIVE", stripeSubscriptionId: `sub_${tag}_${users.length}`, stripePriceId: `price_${code}`, currentPeriodStart: PERIOD_START, currentPeriodEnd: PERIOD_END },
    });
    stripe = { price: `price_${code}`, schedule: null };
    return { id, rowId: row.id };
  }

  const ukTenant = () => prisma.tenant.findUniqueOrThrow({ where: { code: "UK" }, select: { id: true } });
  const planOf = async (userId: string) => (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { paymentPlan: { select: { code: true } } } })).paymentPlan?.code;
  const rowOf = (id: string) => prisma.paymentPlanSubscription.findUniqueOrThrow({ where: { id } });
  const called = (method: string) => calls.filter((c) => c.method === method);

  before(async () => {
    const { id: tenantId } = await ukTenant();
    for (const p of await prisma.paymentPlan.findMany({ where: { tenantId, planType: "B2B_SUBSCRIPTION", code: { in: ["standard", "pro", "max"] } } })) plans[p.code] = p;
  });

  beforeEach(() => {
    calls = [];
    const record = (method: string, result: (...args: any[]) => unknown) => async (...args: unknown[]) => (calls.push({ method, args }), result(...args));
    restore = (() => {
      const all = [stash(provider, ["retrievePaymentPlanSubscription", "previewPaymentPlanUpgrade", "upgradePaymentPlanSubscription", "schedulePaymentPlanDowngrade", "releasePaymentPlanSchedule"]), stash(PaymentPlanStripeSyncSvc, ["ensureStripePrice"]), stash(socket, ["emitToUser"])];
      return () => all.forEach((r) => r());
    })();
    const p = provider as any;
    p.retrievePaymentPlanSubscription = record("retrieve", () => subscription());
    p.previewPaymentPlanUpgrade = record("preview", () => ({ amountDueMinor: 1500, currency: "usd" }));
    p.upgradePaymentPlanSubscription = record("upgrade", (_sub: unknown, price: string) => ((stripe.price = price), subscription()));
    p.schedulePaymentPlanDowngrade = record("schedule", () => (stripe.schedule = "sub_sched_1"));
    p.releasePaymentPlanSchedule = record("release", () => (stripe.schedule = null));
    (PaymentPlanStripeSyncSvc as any).ensureStripePrice = async (plan: { code: string }) => `price_${plan.code}`;
    (socket as any).emitToUser = () => undefined;
  });
  afterEach(() => restore());

  after(async () => {
    await prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await prisma.paymentPlanSubscription.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  });

  describe("upgrading", () => {
    it("previews the prorated amount Stripe will charge now", async () => {
      const { id } = await subscriber("standard");
      const preview = await PaymentPlanBillingSvc.previewChange(id, "pro");
      expect(preview).to.include({ kind: "UPGRADE", planCode: "pro", amountDueNow: 15, currency: "USD", effectiveAt: null });
      expect(called("preview")[0].args[1]).to.equal("price_pro");
      expect(called("upgrade")).to.have.length(0);
    });

    it("charges and moves the lawyer onto the higher tier at once", async () => {
      const { id, rowId } = await subscriber("standard");
      const options = await PaymentPlanBillingSvc.changePlan(id, "pro");

      expect(called("upgrade")).to.have.length(1);
      expect(called("upgrade")[0].args[1]).to.equal("price_pro");
      expect(await planOf(id)).to.equal("pro");
      expect(await rowOf(rowId)).to.include({ paymentPlanId: plans.pro.id, stripePriceId: "price_pro" });
      expect(options).to.include({ currentPlanCode: "pro", subscribed: true, scheduledPlanCode: null });
      const notice = await prisma.notification.findFirst({ where: { userId: id } });
      expect(notice?.title).to.equal("You're on Pro now");
    });

    it("doesn't charge twice when the change already went through", async () => {
      const { id } = await subscriber("standard");
      stripe.price = "price_pro";
      await PaymentPlanBillingSvc.changePlan(id, "pro");
      expect(called("upgrade")).to.have.length(0);
      expect(await planOf(id)).to.equal("pro");
    });

    it("leaves everything as it was when the card is declined", async () => {
      const { id, rowId } = await subscriber("standard");
      (provider as any).upgradePaymentPlanSubscription = async () => {
        throw new HttpError("Your card was declined, so your plan wasn't changed. Nothing was charged.", 402, "PAYMENT_DECLINED");
      };
      expect(await errorOf(PaymentPlanBillingSvc.changePlan(id, "max"))).to.deep.equal({ status: 402, code: "PAYMENT_DECLINED" });
      expect(await planOf(id)).to.equal("standard");
      expect((await rowOf(rowId)).paymentPlanId).to.equal(plans.standard.id);
    });
  });

  describe("downgrading", () => {
    it("schedules the lower tier for the end of the paid period, keeping the current one until then", async () => {
      const { id, rowId } = await subscriber("pro");
      expect(await PaymentPlanBillingSvc.previewChange(id, "standard")).to.deep.include({ kind: "DOWNGRADE", amountDueNow: 0, effectiveAt: PERIOD_END });

      const options = await PaymentPlanBillingSvc.changePlan(id, "standard");
      expect(called("schedule")[0].args[1]).to.equal("price_standard");
      expect(await planOf(id)).to.equal("pro");
      expect(await rowOf(rowId)).to.include({ scheduledPaymentPlanId: plans.standard.id, stripeScheduleId: "sub_sched_1" });
      expect(options).to.deep.include({ currentPlanCode: "pro", scheduledPlanCode: "standard", renewsAt: PERIOD_END });
    });

    it("lands when Stripe moves the subscription onto that tier", async () => {
      const { id, rowId } = await subscriber("pro");
      await PaymentPlanBillingSvc.changePlan(id, "standard");
      await PaymentPlanSubscriptionRepo.sync(rowId, { status: "ACTIVE", paymentPlanId: plans.standard.id, stripePriceId: "price_standard", currentPeriodStart: PERIOD_END, currentPeriodEnd: new Date("2027-01-01T00:00:00Z"), cancelAtPeriodEnd: false });
      expect(await planOf(id)).to.equal("standard");
      expect(await rowOf(rowId)).to.include({ scheduledPaymentPlanId: null, stripeScheduleId: null });
    });

    it("is undone by choosing the current tier again", async () => {
      const { id, rowId } = await subscriber("pro");
      await PaymentPlanBillingSvc.changePlan(id, "standard");
      expect((await PaymentPlanBillingSvc.previewChange(id, "pro")).kind).to.equal("KEEP");

      const options = await PaymentPlanBillingSvc.changePlan(id, "pro");
      expect(called("release")[0].args[0]).to.equal("sub_sched_1");
      expect(await rowOf(rowId)).to.include({ scheduledPaymentPlanId: null, stripeScheduleId: null });
      expect(options).to.include({ currentPlanCode: "pro", scheduledPlanCode: null });
    });

    it("is dropped by upgrading instead", async () => {
      const { id, rowId } = await subscriber("pro");
      await PaymentPlanBillingSvc.changePlan(id, "standard");
      await PaymentPlanBillingSvc.changePlan(id, "max");
      expect(called("release")).to.have.length(1);
      expect(await planOf(id)).to.equal("max");
      expect((await rowOf(rowId)).scheduledPaymentPlanId).to.equal(null);
    });
  });

  it("refuses a change with nothing to change", async () => {
    const { id } = await subscriber("standard");
    expect(await errorOf(PaymentPlanBillingSvc.changePlan(id, "standard"))).to.deep.equal({ status: 409, code: "SAME_PLAN" });
    expect(await errorOf(PaymentPlanBillingSvc.changePlan(id, "nope"))).to.deep.equal({ status: 404, code: "PAYMENT_PLAN_NOT_FOUND" });

    const unpaid = crypto.randomUUID();
    users.push(unpaid);
    await prisma.user.create({ data: { id: unpaid, email: `change-${tag}-unpaid@example.com`, username: `change-${tag}-unpaid`, role: "LAWYER", tenantId: (await ukTenant()).id, paymentPlanId: plans.standard.id } });
    expect(await errorOf(PaymentPlanBillingSvc.changePlan(unpaid, "pro"))).to.deep.equal({ status: 409, code: "NOT_SUBSCRIBED" });
  });
});
