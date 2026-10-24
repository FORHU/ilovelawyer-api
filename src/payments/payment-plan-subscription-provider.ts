import Stripe from "stripe";
import { STRIPE_PUBLISHABLE_KEY } from "../config";
import { stripeClient } from "./stripe-client";
import HttpError from "../utils/http-error";

export interface PaymentPlanCheckoutRequest {
  /** Our PaymentPlanSubscription id: Stripe hands it back on the webhook (metadata and client_reference_id). */
  subscriptionId: string;
  userId: string;
  paymentPlanId: string;
  /** The tier's recurring Price (PaymentPlanStripeSyncSvc.ensureStripePrice). */
  stripePriceId: string;
  customerEmail: string | null;
  /** Where Stripe sends the lawyer back, only for the few payment methods that must leave the page. */
  returnUrl: string;
}

export interface PaymentPlanCheckout {
  externalId: string;
  clientSecret: string;
  publishableKey: string;
}

/** Distinguishes this checkout's webhook events from the client app's and the account top-up's, so
 * the one POST /api/webhooks/stripe dispatch routes each event to the right service. Also on the
 * Stripe Subscription itself (subscription_data.metadata). */
export const PAYMENT_PLAN_METADATA_KIND = "PAYMENT_PLAN_SUBSCRIPTION";

/** An abandoned checkout expires after this. Mirrors account-topup-provider.ts. */
const CHECKOUT_LIFETIME_SECONDS = 35 * 60;

/** Opens an embedded Stripe Checkout Session that starts a lawyer's monthly subscription to one tier.
 * Stripe makes the customer from the email, takes the first month's fee now, and bills monthly
 * after that; the subscription's state comes back on the webhook (PaymentPlanBillingSvc). */
export async function createPaymentPlanCheckout(request: PaymentPlanCheckoutRequest): Promise<PaymentPlanCheckout> {
  if (!STRIPE_PUBLISHABLE_KEY) throw new HttpError("Stripe isn't configured on this server", 500, "STRIPE_NOT_CONFIGURED");
  const metadata = { kind: PAYMENT_PLAN_METADATA_KIND, subscriptionId: request.subscriptionId, userId: request.userId, paymentPlanId: request.paymentPlanId };
  const session = await stripeClient().checkout.sessions.create(
    {
      mode: "subscription",
      ui_mode: "embedded_page",
      redirect_on_completion: "if_required",
      return_url: request.returnUrl,
      client_reference_id: request.subscriptionId,
      metadata,
      subscription_data: { metadata },
      ...(request.customerEmail ? { customer_email: request.customerEmail } : {}),
      expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_LIFETIME_SECONDS,
      line_items: [{ price: request.stripePriceId, quantity: 1 }],
    },
    // A retried request (a network blip) reuses the session instead of opening a second one.
    { idempotencyKey: `payment-plan-checkout-${request.subscriptionId}` },
  );
  if (!session.client_secret) throw new HttpError("Stripe didn't return a checkout to show", 502, "PAYMENT_PROVIDER_ERROR");
  return { externalId: session.id, clientSecret: session.client_secret, publishableKey: STRIPE_PUBLISHABLE_KEY };
}

/** The checkout session, read fresh, with the subscription it started (if any) expanded. */
export async function paymentPlanCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session> {
  return stripeClient().checkout.sessions.retrieve(sessionId, { expand: ["subscription"] });
}

/** Closes an open checkout so it can't be paid any more — when the lawyer starts one for another tier. */
export async function expirePaymentPlanCheckout(sessionId: string): Promise<void> {
  await stripeClient().checkout.sessions.expire(sessionId);
}

export async function retrievePaymentPlanSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
  return stripeClient().subscriptions.retrieve(subscriptionId);
}

/** What moving a subscription's one item onto `stripePriceId` right now would charge (the prorated
 * difference for the rest of the period), in the smallest currency unit, without changing anything. */
export async function previewPaymentPlanUpgrade(subscription: Stripe.Subscription, stripePriceId: string): Promise<{ amountDueMinor: number; currency: string }> {
  const invoice = await stripeClient().invoices.createPreview({
    subscription: subscription.id,
    subscription_details: { items: [{ id: subscription.items.data[0].id, price: stripePriceId }], proration_behavior: "always_invoice" },
  });
  return { amountDueMinor: invoice.amount_due, currency: invoice.currency };
}

/** Moves a subscription onto a higher tier's Price now and charges the prorated difference to the
 * card on file in the same request: a declined card (or one that needs the cardholder) fails the
 * request with 402 PAYMENT_DECLINED and changes nothing (payment_behavior: error_if_incomplete). */
export async function upgradePaymentPlanSubscription(subscription: Stripe.Subscription, stripePriceId: string, idempotencyKey: string): Promise<Stripe.Subscription> {
  try {
    return await stripeClient().subscriptions.update(
      subscription.id,
      {
        items: [{ id: subscription.items.data[0].id, price: stripePriceId }],
        proration_behavior: "always_invoice",
        payment_behavior: "error_if_incomplete",
      },
      { idempotencyKey },
    );
  } catch (err) {
    if (err instanceof Stripe.errors.StripeCardError) {
      throw new HttpError("Your card was declined, so your plan wasn't changed. Nothing was charged.", 402, "PAYMENT_DECLINED");
    }
    throw err;
  }
}

/** Moves a subscription onto a lower tier's Price at the end of the period already paid for, with no
 * refund: a Subscription Schedule whose current phase keeps today's Price until then and whose next
 * one bills the new Price, released afterwards so the subscription simply carries on. Reuses the
 * subscription's schedule when it already has one (a downgrade chosen again). Returns its id. */
export async function schedulePaymentPlanDowngrade(subscription: Stripe.Subscription, stripePriceId: string): Promise<string> {
  const stripe = stripeClient();
  const existing = typeof subscription.schedule === "string" ? subscription.schedule : subscription.schedule?.id;
  const schedule = existing ? await stripe.subscriptionSchedules.retrieve(existing) : await stripe.subscriptionSchedules.create({ from_subscription: subscription.id });
  const item = subscription.items.data[0];
  await stripe.subscriptionSchedules.update(schedule.id, {
    end_behavior: "release",
    phases: [
      { items: [{ price: item.price.id, quantity: 1 }], start_date: item.current_period_start, end_date: item.current_period_end, proration_behavior: "none" },
      { items: [{ price: stripePriceId, quantity: 1 }], duration: { interval: "month", interval_count: 1 }, proration_behavior: "none" },
    ],
  });
  return schedule.id;
}

/** Drops a scheduled downgrade: the subscription stays on the Price it has now. */
export async function releasePaymentPlanSchedule(scheduleId: string): Promise<void> {
  await stripeClient().subscriptionSchedules.release(scheduleId);
}
