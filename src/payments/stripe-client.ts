import Stripe from "stripe";
import { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET } from "../config";
import HttpError from "../utils/http-error";

let client: Stripe | null = null;

/** The one Stripe client, made on first use so an environment without Stripe keys still boots.
 * Shared by the client app's payments and, later, the lawyer's card (ilovelawyer-api#505). */
export function stripeClient(): Stripe {
  if (!STRIPE_SECRET_KEY) throw new HttpError("Stripe isn't configured on this server", 500, "STRIPE_NOT_CONFIGURED");
  if (!client) client = new Stripe(STRIPE_SECRET_KEY, { maxNetworkRetries: 2, appInfo: { name: "ilovelawyer-api" } });
  return client;
}

/** Checks a webhook delivery's Stripe-Signature against STRIPE_WEBHOOK_SECRET and parses it. Throws
 * a 400 for a bad or missing signature, so a forged call is refused before anything reads it. */
export function verifyStripeWebhook(rawBody: Buffer, signature: string | undefined, secret = STRIPE_WEBHOOK_SECRET): Stripe.Event {
  if (!secret) throw new HttpError("Stripe webhooks aren't configured on this server", 500, "STRIPE_NOT_CONFIGURED");
  if (!signature) throw new HttpError("Missing Stripe-Signature header", 400, "STRIPE_SIGNATURE_INVALID");
  try {
    return Stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    throw new HttpError("Invalid Stripe signature", 400, "STRIPE_SIGNATURE_INVALID");
  }
}
