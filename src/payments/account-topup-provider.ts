import { STRIPE_PUBLISHABLE_KEY } from "../config";
import { stripeClient } from "./stripe-client";
import { outcomeOfSession, type CheckoutOutcome } from "./client-payment-provider";
import HttpError from "../utils/http-error";

export interface AccountTopUpCheckoutRequest {
  /** Our AccountAiTopUp id: Stripe hands it back on the webhook (metadata and client_reference_id). */
  topUpId: string;
  userId: string;
  /** The full charge (top-up plus fee) in `currency`'s smallest unit: cents, or whole won on KR, which
   * Stripe treats as zero-decimal, so it's Stripe's unit_amount as it is. */
  currency: string;
  totalChargedMinor: number;
  customerEmail: string | null;
  /** Where Stripe sends the lawyer back, only for the few payment methods that must leave the page. */
  returnUrl: string;
}

export interface AccountTopUpCheckout {
  externalId: string;
  clientSecret: string;
  publishableKey: string;
}

/** Distinguishes this checkout's webhook events from ClientBillingSvc's, so the one
 * POST /api/webhooks/stripe dispatch can route each event to the right service. */
export const ACCOUNT_TOPUP_METADATA_KIND = "ACCOUNT_TOPUP";

/** An abandoned checkout expires (and the top-up fails) after this. Mirrors
 * client-payment-provider.ts's CHECKOUT_LIFETIME_SECONDS. */
const CHECKOUT_LIFETIME_SECONDS = 35 * 60;

/** Opens a Stripe Checkout Session for a lawyer's self-serve account AI top-up — embedded, like the
 * client app's payment flow, so the page never navigates away. Shares the one Stripe client and
 * webhook mount (stripe-client.ts) with ClientBillingSvc, but is its own provider: different metadata
 * shape, no promo/credits concepts. */
export async function createAccountTopUpCheckout(request: AccountTopUpCheckoutRequest): Promise<AccountTopUpCheckout> {
  if (!STRIPE_PUBLISHABLE_KEY) throw new HttpError("Stripe isn't configured on this server", 500, "STRIPE_NOT_CONFIGURED");
  const metadata = { kind: ACCOUNT_TOPUP_METADATA_KIND, topUpId: request.topUpId, userId: request.userId };
  const session = await stripeClient().checkout.sessions.create(
    {
      mode: "payment",
      ui_mode: "embedded_page",
      redirect_on_completion: "if_required",
      return_url: request.returnUrl,
      client_reference_id: request.topUpId,
      metadata,
      payment_intent_data: { metadata },
      ...(request.customerEmail ? { customer_email: request.customerEmail } : {}),
      expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_LIFETIME_SECONDS,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: request.currency.toLowerCase(),
            unit_amount: request.totalChargedMinor,
            product_data: { name: "ilovelawyer account AI top-up" },
          },
        },
      ],
    },
    // A retried request (a network blip) reuses the session instead of opening a second one.
    { idempotencyKey: `account-topup-${request.topUpId}` },
  );
  if (!session.client_secret) throw new HttpError("Stripe didn't return a checkout to show", 502, "PAYMENT_PROVIDER_ERROR");
  return { externalId: session.id, clientSecret: session.client_secret, publishableKey: STRIPE_PUBLISHABLE_KEY };
}

export async function accountTopUpCheckoutOutcome(externalId: string): Promise<CheckoutOutcome> {
  const session = await stripeClient().checkout.sessions.retrieve(externalId);
  return outcomeOfSession(session);
}
