import crypto from "crypto";
import { CLIENT_PAYMENT_PROVIDER, STRIPE_PUBLISHABLE_KEY } from "../config";
import { stripeClient } from "./stripe-client";
import HttpError from "../utils/http-error";

/**
 * Takes the client app's payments (a new case, a credit top-up). Two providers, chosen by
 * CLIENT_PAYMENT_PROVIDER:
 *
 *  - DUMMY ("immediate"): charges nothing and settles on the spot. The default, for local and dev.
 *  - STRIPE ("checkout"): opens a Stripe Checkout Session shown inside the client app (embedded, so
 *    the page never navigates away). The payment stays PENDING until Stripe says it's paid, through
 *    the webhook or when the app asks (checkoutOutcome).
 *
 * The client app never sends card details: Stripe's own form takes them. ClientBillingSvc only
 * stores what comes back, so the lawyer's card (ilovelawyer-api#505) can reuse the same Stripe
 * client (stripe-client.ts) and webhook mount.
 */
export interface ClientChargeRequest {
  userId: string;
  amountMinor: number;
  currency: string;
  description: string;
  /** "decline" asks the dummy to refuse, so the app's failure screen can be tested. Stripe ignores
   * it: use one of Stripe's declining test cards instead. */
  testOutcome?: "decline";
}

export type ClientChargeResult = { ok: true; externalId: string } | { ok: false; reason: string };

export interface ClientCheckoutRequest {
  /** Our ClientPayment id: Stripe hands it back on the webhook (metadata and client_reference_id). */
  paymentId: string;
  userId: string;
  customerEmail: string | null;
  amountMinor: number;
  currency: string;
  description: string;
  /** Where Stripe sends the client back, only for the few payment methods that must leave the page. */
  returnUrl: string;
}

export interface ClientCheckout {
  externalId: string;
  /** For Stripe.js's embedded checkout in the client app. */
  clientSecret: string;
  publishableKey: string;
}

/** Where a checkout stands at Stripe. */
export type CheckoutOutcome = "paid" | "open" | "expired" | "failed";

export interface ImmediateClientPaymentProvider {
  readonly name: "DUMMY";
  readonly mode: "immediate";
  charge(request: ClientChargeRequest): Promise<ClientChargeResult>;
}

export interface CheckoutClientPaymentProvider {
  readonly name: "STRIPE";
  readonly mode: "checkout";
  createCheckout(request: ClientCheckoutRequest): Promise<ClientCheckout>;
  checkoutOutcome(externalId: string): Promise<CheckoutOutcome>;
}

export type ClientPaymentProvider = ImmediateClientPaymentProvider | CheckoutClientPaymentProvider;

export const dummyClientPaymentProvider: ImmediateClientPaymentProvider = {
  name: "DUMMY",
  mode: "immediate",
  async charge(request) {
    if (request.testOutcome === "decline") {
      return { ok: false, reason: "Your payment was declined by the bank. Try another method." };
    }
    return { ok: true, externalId: `dummy_${crypto.randomUUID()}` };
  },
};

/** An abandoned checkout expires (and its payment fails) after this. Stripe's minimum is 30 minutes
 * from when it receives the request, so this leaves a margin for the request's own travel time. */
const CHECKOUT_LIFETIME_SECONDS = 35 * 60;

export const stripeClientPaymentProvider: CheckoutClientPaymentProvider = {
  name: "STRIPE",
  mode: "checkout",
  async createCheckout(request) {
    if (!STRIPE_PUBLISHABLE_KEY) throw new HttpError("Stripe isn't configured on this server", 500, "STRIPE_NOT_CONFIGURED");
    const session = await stripeClient().checkout.sessions.create(
      {
        mode: "payment",
        ui_mode: "embedded_page",
        // Cards complete in place; only a method that has to leave the page comes back to returnUrl.
        redirect_on_completion: "if_required",
        return_url: request.returnUrl,
        client_reference_id: request.paymentId,
        metadata: { paymentId: request.paymentId, userId: request.userId },
        payment_intent_data: { metadata: { paymentId: request.paymentId, userId: request.userId } },
        ...(request.customerEmail ? { customer_email: request.customerEmail } : {}),
        expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_LIFETIME_SECONDS,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: request.currency.toLowerCase(),
              unit_amount: request.amountMinor,
              product_data: { name: request.description },
            },
          },
        ],
      },
      // A retried request (a network blip) reuses the session instead of opening a second one.
      { idempotencyKey: `client-payment-${request.paymentId}` },
    );
    if (!session.client_secret) throw new HttpError("Stripe didn't return a checkout to show", 502, "PAYMENT_PROVIDER_ERROR");
    return { externalId: session.id, clientSecret: session.client_secret, publishableKey: STRIPE_PUBLISHABLE_KEY };
  },
  async checkoutOutcome(externalId) {
    const session = await stripeClient().checkout.sessions.retrieve(externalId);
    return outcomeOfSession(session);
  },
};

/** A Checkout Session's state as one of ours. "complete" but unpaid is an asynchronous method (a
 * bank debit) still clearing: it stays open until Stripe sends async_payment_succeeded/failed. */
export function outcomeOfSession(session: { status: string | null; payment_status: string }): CheckoutOutcome {
  if (session.status === "expired") return "expired";
  if (session.status === "complete") return session.payment_status === "paid" || session.payment_status === "no_payment_required" ? "paid" : "open";
  return "open";
}

let override: ClientPaymentProvider | null = null;

export function clientPaymentProvider(): ClientPaymentProvider {
  if (override) return override;
  return CLIENT_PAYMENT_PROVIDER === "stripe" ? stripeClientPaymentProvider : dummyClientPaymentProvider;
}

/** Tests only; null goes back to the configured provider. */
export function setClientPaymentProvider(next: ClientPaymentProvider | null): void {
  override = next;
}
