import crypto from "crypto";
import Stripe from "stripe";
import { QUOTATION_PAYMENT_PROVIDER, STRIPE_PUBLISHABLE_KEY } from "../config";
import { stripeClient } from "./stripe-client";
import { refundResultOf, type ClientRefundResult } from "./client-refunds";
import HttpError from "../utils/http-error";

/**
 * Takes a client's payment for a lawyer's accepted quotation (QuotationPaymentSvc). Two providers,
 * chosen by QUOTATION_PAYMENT_PROVIDER:
 *
 *  - DUMMY ("immediate"): charges nothing and settles on the spot. The default, for local and dev.
 *  - STRIPE ("intent"): a PaymentIntent on the platform's own account, for the quotation's accepted
 *    amount, that the client app confirms with Stripe's Payment Element. The money lands on
 *    ilovelawyer's balance (separate charges and transfers): the lawyer is paid out of their wallet
 *    later, through Stripe Connect. It settles on payment_intent.succeeded, or when the app asks.
 *
 * Refunds and cancels go through the provider the payment was taken with (QuotationPayment.provider),
 * so a dummy payment is never refunded through Stripe.
 */
export interface QuotationPaymentRequest {
  /** Our QuotationPayment id: the idempotency key and handed back on the webhook (metadata). */
  paymentId: string;
  quotationId: string;
  requestId: string;
  clientId: string;
  amountMinor: number;
  currency: string;
  description: string;
  customerEmail: string | null;
  /** "decline" asks the dummy to refuse, so the app's failure screen can be tested. */
  testOutcome?: "decline";
}

export interface QuotationPaymentResult {
  /** PENDING: the client still has to confirm it (Stripe), or the bank is still deciding. */
  status: "SUCCEEDED" | "PENDING" | "FAILED" | "CANCELED";
  paymentIntentId: string | null;
  failureReason: string | null;
}

export interface QuotationIntent {
  paymentIntentId: string;
  /** For Stripe.js's Payment Element in the client app. */
  clientSecret: string;
  publishableKey: string;
}

export interface QuotationRefundRequest {
  /** Our QuotationRefund id: the idempotency key, and handed back on refund.updated. */
  refundId: string;
  paymentId: string;
  paymentIntentId: string;
  amountMinor: number;
}

export interface ImmediateQuotationPaymentProvider {
  readonly name: "DUMMY";
  readonly mode: "immediate";
  pay(request: QuotationPaymentRequest): Promise<QuotationPaymentResult>;
  refund(request: QuotationRefundRequest): Promise<ClientRefundResult>;
}

export interface IntentQuotationPaymentProvider {
  readonly name: "STRIPE";
  readonly mode: "intent";
  createIntent(request: QuotationPaymentRequest): Promise<QuotationIntent>;
  /** An open intent's client secret again, for a client who closed the form and came back. */
  resumeIntent(paymentIntentId: string): Promise<QuotationIntent & QuotationPaymentResult>;
  /** Where one of our payments stands now, read fresh (webhook events can arrive out of order). */
  status(paymentIntentId: string): Promise<QuotationPaymentResult>;
  /** Cancels an intent the client never finished, when its quotation expires. Returns where it ended:
   * SUCCEEDED when the client paid just before, which the caller must honour. */
  cancel(paymentIntentId: string): Promise<QuotationPaymentResult>;
  refund(request: QuotationRefundRequest): Promise<ClientRefundResult>;
}

export type QuotationPaymentProvider = ImmediateQuotationPaymentProvider | IntentQuotationPaymentProvider;

/** metadata.purpose on our PaymentIntents, which tells the shared webhook it's a quotation payment. */
export const QUOTATION_PAYMENT_PURPOSE = "quotation_payment";
/** metadata.purpose on refunds of them, which tells refund.updated whose refund it is. */
export const QUOTATION_REFUND_PURPOSE = "quotation_refund";

/** A PaymentIntent as one of our results. Anything the client can still act on is PENDING. */
export function quotationResultOf(intent: Pick<Stripe.PaymentIntent, "id" | "status" | "last_payment_error">): QuotationPaymentResult {
  if (intent.status === "succeeded") return { status: "SUCCEEDED", paymentIntentId: intent.id, failureReason: null };
  if (intent.status === "canceled") return { status: "CANCELED", paymentIntentId: intent.id, failureReason: "The payment was cancelled." };
  // requires_payment_method after an attempt: the card was declined, and the client can try another
  // on the same intent. Before any attempt there's no error, so it's still waiting on them.
  if (intent.status === "requires_payment_method" && intent.last_payment_error) {
    return { status: "FAILED", paymentIntentId: intent.id, failureReason: intent.last_payment_error.message ?? "The card was declined." };
  }
  return { status: "PENDING", paymentIntentId: intent.id, failureReason: null };
}

export const dummyQuotationPaymentProvider: ImmediateQuotationPaymentProvider = {
  name: "DUMMY",
  mode: "immediate",
  async pay(request) {
    if (request.testOutcome === "decline") {
      return { status: "FAILED", paymentIntentId: null, failureReason: "Your payment was declined by the bank. Try another method." };
    }
    return { status: "SUCCEEDED", paymentIntentId: `dummy_pi_${crypto.randomUUID()}`, failureReason: null };
  },
  // A dummy payment took no money, so its refund only records that it happened.
  async refund(request) {
    return { externalId: `dummy_re_${request.refundId}`, status: "SUCCEEDED", failureReason: null };
  },
};

function intentOf(intent: Stripe.PaymentIntent): QuotationIntent {
  if (!STRIPE_PUBLISHABLE_KEY) throw new HttpError("Stripe isn't configured on this server", 500, "STRIPE_NOT_CONFIGURED");
  if (!intent.client_secret) throw new HttpError("Stripe didn't return a payment to confirm", 502, "PAYMENT_PROVIDER_ERROR");
  return { paymentIntentId: intent.id, clientSecret: intent.client_secret, publishableKey: STRIPE_PUBLISHABLE_KEY };
}

export const stripeQuotationPaymentProvider: IntentQuotationPaymentProvider = {
  name: "STRIPE",
  mode: "intent",
  async createIntent(request) {
    const intent = await stripeClient().paymentIntents.create(
      {
        amount: request.amountMinor,
        currency: request.currency.toLowerCase(),
        automatic_payment_methods: { enabled: true },
        description: request.description,
        ...(request.customerEmail ? { receipt_email: request.customerEmail } : {}),
        // The lawyer's payout later belongs to the same group, so Stripe's reports tie them together.
        transfer_group: request.requestId,
        metadata: {
          purpose: QUOTATION_PAYMENT_PURPOSE,
          paymentId: request.paymentId,
          quotationId: request.quotationId,
          requestId: request.requestId,
          clientId: request.clientId,
        },
      },
      // A retried request (a network blip) gets the same intent instead of a second one.
      { idempotencyKey: `quotation-payment-${request.paymentId}` },
    );
    return intentOf(intent);
  },
  async resumeIntent(paymentIntentId) {
    const intent = await stripeClient().paymentIntents.retrieve(paymentIntentId);
    return { ...quotationResultOf(intent), ...intentOf(intent) };
  },
  async status(paymentIntentId) {
    return quotationResultOf(await stripeClient().paymentIntents.retrieve(paymentIntentId));
  },
  async cancel(paymentIntentId) {
    try {
      return quotationResultOf(await stripeClient().paymentIntents.cancel(paymentIntentId));
    } catch (err) {
      // Already succeeded, processing or cancelled: Stripe refuses, and the intent says where it is.
      if (err instanceof Stripe.errors.StripeInvalidRequestError) return quotationResultOf(await stripeClient().paymentIntents.retrieve(paymentIntentId));
      throw err;
    }
  },
  async refund(request) {
    const refund = await stripeClient().refunds.create(
      {
        payment_intent: request.paymentIntentId,
        amount: request.amountMinor,
        metadata: { purpose: QUOTATION_REFUND_PURPOSE, refundId: request.refundId, paymentId: request.paymentId },
      },
      { idempotencyKey: `quotation-refund-${request.refundId}` },
    );
    return refundResultOf(refund);
  },
};

let override: QuotationPaymentProvider | null = null;

export function quotationPaymentProvider(): QuotationPaymentProvider {
  if (override) return override;
  return QUOTATION_PAYMENT_PROVIDER === "stripe" ? stripeQuotationPaymentProvider : dummyQuotationPaymentProvider;
}

/** The provider a payment was taken with (QuotationPayment.provider), for refunding or cancelling it.
 * A test's override stands in for the provider of the same name. */
export function quotationPaymentProviderNamed(name: string): QuotationPaymentProvider {
  if (override && override.name === name) return override;
  return name === "STRIPE" ? stripeQuotationPaymentProvider : dummyQuotationPaymentProvider;
}

/** Tests only; null goes back to the configured provider. */
export function setQuotationPaymentProvider(next: QuotationPaymentProvider | null): void {
  override = next;
}
