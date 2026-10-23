import type Stripe from "stripe";
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
