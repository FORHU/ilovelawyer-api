import type Stripe from "stripe";
import { stripeClient } from "./stripe-client";

/**
 * Gives money back on a client app payment taken through Stripe Checkout (ClientBillingAdminSvc.refund).
 * It goes by the payment's stored provider, not CLIENT_PAYMENT_PROVIDER: a Stripe payment is always
 * refunded through Stripe, even on a server since switched to the dummy.
 */
export interface ClientRefundRequest {
  /** Our ClientRefund id: the idempotency key, and handed back on Stripe's refund webhooks. */
  refundId: string;
  paymentId: string;
  /** The payment's Checkout Session (ClientPayment.externalId). */
  checkoutSessionId: string;
  amountMinor: number;
}

export interface ClientRefundResult {
  externalId: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  failureReason: string | null;
}

export type ClientRefunder = (request: ClientRefundRequest) => Promise<ClientRefundResult>;

/** A Stripe Refund's status as one of ours. requires_action (a refund Stripe needs more details for)
 * is still on its way, so it stays PENDING. */
export function refundStatusOf(status: string | null): ClientRefundResult["status"] {
  if (status === "succeeded") return "SUCCEEDED";
  if (status === "failed" || status === "canceled") return "FAILED";
  return "PENDING";
}

export function refundResultOf(refund: Pick<Stripe.Refund, "id" | "status" | "failure_reason">): ClientRefundResult {
  const status = refundStatusOf(refund.status);
  return { externalId: refund.id, status, failureReason: status === "FAILED" ? (refund.failure_reason ?? "Stripe couldn't complete the refund") : null };
}

export const stripeClientRefunder: ClientRefunder = async (request) => {
  const stripe = stripeClient();
  const session = await stripe.checkout.sessions.retrieve(request.checkoutSessionId);
  const paymentIntent = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  if (!paymentIntent) throw new Error(`Checkout Session ${request.checkoutSessionId} has no payment to refund`);
  const refund = await stripe.refunds.create(
    {
      payment_intent: paymentIntent,
      amount: request.amountMinor,
      metadata: { refundId: request.refundId, paymentId: request.paymentId },
    },
    // A retried request (a network blip) can't refund twice.
    { idempotencyKey: `client-refund-${request.refundId}` },
  );
  return refundResultOf(refund);
};

let override: ClientRefunder | null = null;

export function clientRefunder(): ClientRefunder {
  return override ?? stripeClientRefunder;
}

/** Tests only; null goes back to Stripe. */
export function setClientRefunder(next: ClientRefunder | null): void {
  override = next;
}
