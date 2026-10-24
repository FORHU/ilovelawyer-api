import type { PaymentPlanSubscription, PaymentPlanSubscriptionStatus } from "@prisma/client";
import type Stripe from "stripe";
import prisma from "../lib/prisma";
import { emitToUser } from "../lib/socket";
import PaymentPlanSubscriptionRepo, { type SubscriptionPeriod } from "../repositories/payment-plan-subscription.repository";
import PaymentPlanStripeSyncSvc from "./payment-plan-stripe-sync.service";
import {
  createPaymentPlanCheckout,
  expirePaymentPlanCheckout,
  paymentPlanCheckoutSession,
  retrievePaymentPlanSubscription,
  PAYMENT_PLAN_METADATA_KIND,
  type PaymentPlanCheckout,
} from "../payments/payment-plan-subscription-provider";
import { outcomeOfSession } from "../payments/client-payment-provider";
import { returnOrigin } from "./client-billing.service";
import { STRIPE_PUBLISHABLE_KEY } from "../config";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

const EXPIRED_REASON = "The payment page expired before you paid. Nothing was charged.";
const REPLACED_REASON = "You chose another plan instead. Nothing was charged.";
const OPEN_FAILED_REASON = "We couldn't open the payment page.";
const PAYMENT_FAILED_REASON = "Your plan's monthly payment didn't go through.";

/** Stripe's subscription states, as ours. Anything not listed (incomplete, trialing, paused) leaves
 * the row as it is. */
const STATUS_FROM_STRIPE: Partial<Record<Stripe.Subscription.Status, PaymentPlanSubscriptionStatus>> = {
  active: "ACTIVE",
  past_due: "PAST_DUE",
  unpaid: "PAST_DUE",
  canceled: "CANCELED",
  incomplete_expired: "EXPIRED",
};

function checkoutDto(checkout: PaymentPlanCheckout) {
  return { provider: "STRIPE" as const, clientSecret: checkout.clientSecret, publishableKey: checkout.publishableKey };
}

/** The billing period of a subscription's one item (Stripe keeps periods per item). */
function periodOf(subscription: Stripe.Subscription): SubscriptionPeriod {
  const item = subscription.items.data[0];
  return {
    currentPeriodStart: new Date(item.current_period_start * 1000),
    currentPeriodEnd: new Date(item.current_period_end * 1000),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  };
}

function idOf(ref: string | { id: string } | null | undefined): string | null {
  return typeof ref === "string" ? ref : (ref?.id ?? null);
}

/** The subscription an invoice bills, if it bills one. */
function subscriptionIdOfInvoice(invoice: Stripe.Invoice): string | null {
  return idOf(invoice.parent?.subscription_details?.subscription);
}

async function lawyerOf(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, tenantId: true, email: true, paymentPlan: { select: { code: true } } } });
  if (user?.role !== "LAWYER") throw new HttpError("Only a lawyer account has a plan", 403, "NOT_A_LAWYER");
  if (!user.tenantId) throw new HttpError("Your account has no region set, so there are no plans to show", 409, "USER_NO_TENANT");
  return { ...user, tenantId: user.tenantId };
}

/**
 * A lawyer's monthly subscription to one of their tenant's tiers (PaymentPlan), through Stripe
 * Checkout in subscription mode — embedded, like the account top-up. Stripe takes the first month at
 * checkout and bills monthly after that; each paid month starts a new allowance period
 * (AccountLimitsSvc.startAllowancePeriod). A subscription that ends leaves the lawyer with no tier,
 * which locks the account read-only, the same as running out of allowance.
 *
 * Billing is per lawyer (PaymentPlanSubscription.userId), even for a lawyer in a firm. Changing tier
 * on a live subscription (upgrade, Stripe's billing portal) isn't built yet: a lawyer with one gets
 * 409 ALREADY_SUBSCRIBED.
 */
export default class PaymentPlanBillingSvc {
  /** The tiers a lawyer can choose from (their tenant's active ones, cheapest first), the one their
   * account is on now, whether they already pay for it, and their free trial: when it ends (null
   * with none) and whether it already has, leaving the account read-only until they subscribe. */
  static async options(userId: string) {
    const user = await lawyerOf(userId);
    const [plans, live, trial] = await Promise.all([
      prisma.paymentPlan.findMany({
        where: { tenantId: user.tenantId, planType: "B2B_SUBSCRIPTION", isActive: true },
        orderBy: { level: "asc" },
        select: { code: true, name: true, description: true, level: true, feeUsd: true, includedAllowanceUsd: true, caseLimit: true },
      }),
      PaymentPlanSubscriptionRepo.findLiveForUser(userId),
      prisma.user.findUnique({ where: { id: userId }, select: { planTrialEndsAt: true } }),
    ]);
    const trialEndsAt = trial?.planTrialEndsAt ?? null;
    return {
      plans,
      currentPlanCode: user.paymentPlan?.code ?? null,
      subscribed: !!live,
      trialEndsAt,
      trialEnded: !live && !!trialEndsAt && trialEndsAt <= new Date(),
    };
  }

  static async startCheckout(userId: string, planCode: string, origin: string | undefined) {
    const user = await lawyerOf(userId);
    const plan = await prisma.paymentPlan.findUnique({ where: { tenantId_planType_code: { tenantId: user.tenantId, planType: "B2B_SUBSCRIPTION", code: planCode } } });
    if (!plan?.isActive) throw new HttpError("That plan isn't available", 404, "PAYMENT_PLAN_NOT_FOUND");
    const returnTo = `${returnOrigin(origin)}/payments/return`;

    // A checkout already paid but not settled yet (no webhook so far) counts as a plan: settle it
    // before deciding, or the lawyer could start — and pay for — a second subscription.
    let open = await PaymentPlanSubscriptionRepo.findOpenForUser(userId);
    if (open) {
      await PaymentPlanBillingSvc.settleFromStripe(open);
      open = await PaymentPlanSubscriptionRepo.findOpenForUser(userId);
    }
    if (await PaymentPlanSubscriptionRepo.findLiveForUser(userId)) {
      throw new HttpError("You already have a plan. Changing plans isn't available yet.", 409, "ALREADY_SUBSCRIBED");
    }

    // Re-opening the same tier's checkout (the step shown again, a second tab) reuses it. A checkout
    // for another tier is closed first, so the lawyer can never pay for two subscriptions.
    if (open) {
      if (open.paymentPlanId === plan.id) {
        const checkout = await PaymentPlanBillingSvc.reopenCheckout(open);
        if (checkout) return { subscriptionId: open.id, status: open.status, planCode: plan.code, checkout: checkoutDto(checkout) };
      } else {
        await expirePaymentPlanCheckout(open.checkoutSessionId!).catch(() => undefined);
        await PaymentPlanSubscriptionRepo.expire(open.id, REPLACED_REASON);
      }
    }

    let stripePriceId: string;
    try {
      stripePriceId = await PaymentPlanStripeSyncSvc.ensureStripePrice(plan);
    } catch (err) {
      logger.error("Stripe price could not be prepared for a subscription tier", { paymentPlanId: plan.id, err: err instanceof Error ? err.message : String(err) });
      if (err instanceof HttpError) throw err;
      throw new HttpError("We couldn't open the payment page. Try again in a moment.", 502, "PAYMENT_PROVIDER_ERROR");
    }

    const pending = await PaymentPlanSubscriptionRepo.create({ userId, paymentPlanId: plan.id, stripePriceId });
    let checkout: PaymentPlanCheckout;
    try {
      checkout = await createPaymentPlanCheckout({
        subscriptionId: pending.id,
        userId,
        paymentPlanId: plan.id,
        stripePriceId,
        customerEmail: user.email,
        returnUrl: `${returnTo}?subscriptionId=${encodeURIComponent(pending.id)}`,
      });
    } catch (err) {
      logger.error("Stripe checkout could not be created for a subscription", { subscriptionId: pending.id, err: err instanceof Error ? err.message : String(err) });
      await PaymentPlanSubscriptionRepo.expire(pending.id, OPEN_FAILED_REASON);
      if (err instanceof HttpError) throw err;
      throw new HttpError("We couldn't open the payment page. Try again in a moment.", 502, "PAYMENT_PROVIDER_ERROR");
    }
    await PaymentPlanSubscriptionRepo.setCheckoutSession(pending.id, checkout.externalId);
    return { subscriptionId: pending.id, status: "PENDING" as const, planCode: plan.code, checkout: checkoutDto(checkout) };
  }

  /** Where a subscription checkout stands. A PENDING one is checked with Stripe first and settled if
   * it has moved on, so the app learns the outcome right after the lawyer pays, without waiting for
   * the webhook (and locally, where no webhook arrives). */
  static async status(userId: string, subscriptionId: string) {
    let row = await PaymentPlanSubscriptionRepo.findForUser(subscriptionId, userId);
    if (!row) throw new HttpError("Subscription not found", 404);
    if (row.status === "PENDING" && row.checkoutSessionId) {
      await PaymentPlanBillingSvc.settleFromStripe(row);
      row = (await PaymentPlanSubscriptionRepo.findForUser(subscriptionId, userId))!;
    }
    return { subscriptionId: row.id, status: row.status, planCode: row.paymentPlan.code, failureReason: row.failureReason };
  }

  /** One verified Stripe webhook event (StripeWebhookSvc has already ruled out a retried delivery).
   * Checkout events are ours by metadata.kind; invoice and subscription events by the Stripe
   * subscription id we stored at activation. Anything else no-ops. */
  static async handleStripeEvent(event: Stripe.Event): Promise<{ handled: boolean }> {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.metadata?.kind !== PAYMENT_PLAN_METADATA_KIND) return { handled: false };
        const rowId = session.metadata?.subscriptionId ?? session.client_reference_id;
        const row = rowId ? await PaymentPlanSubscriptionRepo.findById(rowId) : null;
        if (!row || row.checkoutSessionId !== session.id) {
          logger.info("Stripe webhook: no subscription checkout of ours for this session", { eventId: event.id, sessionId: session.id });
          return { handled: true };
        }
        if (event.type === "checkout.session.expired") await PaymentPlanSubscriptionRepo.expire(row.id, EXPIRED_REASON);
        else await PaymentPlanBillingSvc.settleFromStripe(row);
        return { handled: true };
      }
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const row = await PaymentPlanBillingSvc.rowOfInvoice(invoice);
        if (!row) return { handled: false };
        // The first month is applied by the checkout (activate); a mid-period change only syncs on
        // customer.subscription.updated. Only a renewal (or a retried renewal finally paid) starts a
        // new period.
        if (invoice.billing_reason === "subscription_cycle" && invoice.id) {
          const subscription = await retrievePaymentPlanSubscription(row.stripeSubscriptionId!);
          await PaymentPlanSubscriptionRepo.rollPeriod(row.id, invoice.id, periodOf(subscription));
        }
        return { handled: true };
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const row = await PaymentPlanBillingSvc.rowOfInvoice(invoice);
        if (!row) return { handled: false };
        // No allowance refresh: the lawyer keeps whatever is left of this period. Stripe keeps
        // retrying; once it gives up it cancels the subscription (customer.subscription.deleted).
        if (await PaymentPlanSubscriptionRepo.markPastDue(row.id, PAYMENT_FAILED_REASON)) {
          await PaymentPlanBillingSvc.notify(
            row.userId,
            "Your plan's payment didn't go through",
            "We couldn't take this month's payment for your plan. Stripe will try your card again over the next few days. If it keeps failing, your plan ends and your account becomes read-only.",
          );
        }
        return { handled: true };
      }
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const row = await PaymentPlanSubscriptionRepo.findByStripeSubscriptionId(subscription.id);
        if (!row) return { handled: false };
        const status = STATUS_FROM_STRIPE[subscription.status] ?? row.status;
        const paymentPlanId = (await PaymentPlanBillingSvc.tierOfSubscription(subscription)) ?? row.paymentPlanId;
        await PaymentPlanSubscriptionRepo.sync(row.id, { status, paymentPlanId, ...periodOf(subscription) });
        return { handled: true };
      }
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const row = await PaymentPlanSubscriptionRepo.findByStripeSubscriptionId(subscription.id);
        if (!row) return { handled: false };
        if (await PaymentPlanSubscriptionRepo.cancel(row.id)) {
          await PaymentPlanBillingSvc.notify(row.userId, "Your plan has ended", "Your subscription has ended, so your account is read-only now. You can still see everything. Choose a plan to keep going.");
        }
        return { handled: true };
      }
      default:
        return { handled: false };
    }
  }

  private static async rowOfInvoice(invoice: Stripe.Invoice) {
    const stripeSubscriptionId = subscriptionIdOfInvoice(invoice);
    return stripeSubscriptionId ? PaymentPlanSubscriptionRepo.findByStripeSubscriptionId(stripeSubscriptionId) : null;
  }

  /** Which of our tiers a subscription's item is now on: its Price, or (an older Price, from before
   * a fee change) the tier's Product. */
  private static async tierOfSubscription(subscription: Stripe.Subscription): Promise<string | null> {
    const price = subscription.items.data[0]?.price;
    if (!price) return null;
    const plan = await prisma.paymentPlan.findFirst({ where: { OR: [{ stripePriceId: price.id }, { stripeProductId: idOf(price.product) ?? undefined }] }, select: { id: true } });
    return plan?.id ?? null;
  }

  private static async settleFromStripe(row: PaymentPlanSubscription) {
    if (!row.checkoutSessionId) return;
    try {
      const session = await paymentPlanCheckoutSession(row.checkoutSessionId);
      const outcome = outcomeOfSession(session);
      if (outcome === "expired") {
        await PaymentPlanSubscriptionRepo.expire(row.id, EXPIRED_REASON);
        return;
      }
      if (outcome !== "paid" || !session.subscription) return;
      const subscription = typeof session.subscription === "string" ? await retrievePaymentPlanSubscription(session.subscription) : session.subscription;
      await PaymentPlanSubscriptionRepo.activate(row.id, subscription.id, periodOf(subscription), idOf(subscription.latest_invoice));
    } catch (err) {
      logger.warn("Stripe checkout status could not be read for a subscription", { subscriptionId: row.id, err: err instanceof Error ? err.message : String(err) });
    }
  }

  private static async reopenCheckout(row: PaymentPlanSubscription): Promise<PaymentPlanCheckout | null> {
    if (!row.checkoutSessionId) return null;
    try {
      const session = await paymentPlanCheckoutSession(row.checkoutSessionId);
      if (session.status !== "open" || !session.client_secret || !STRIPE_PUBLISHABLE_KEY) return null;
      return { externalId: session.id, clientSecret: session.client_secret, publishableKey: STRIPE_PUBLISHABLE_KEY };
    } catch {
      return null;
    }
  }

  private static async notify(userId: string, title: string, message: string) {
    const notification = await prisma.notification.create({ data: { userId, type: "SYSTEM", title, message } });
    emitToUser(userId, "notification:new", notification);
  }
}
