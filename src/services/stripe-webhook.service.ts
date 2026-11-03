import type Stripe from "stripe";
import ClientPaymentRepo from "../repositories/client-payment.repository";
import ClientBillingSvc from "./client-billing.service";
import AccountTopUpBillingSvc from "./account-topup-billing.service";
import PaymentPlanBillingSvc from "./payment-plan-billing.service";
import WalletSvc from "./wallet.service";

/**
 * One Stripe account, one webhook mount, three billing services: the client app's payments (and a
 * firm's card and charges, ClientBillingSvc), a lawyer's AI top-up (AccountTopUpBillingSvc) and a
 * lawyer's subscription (PaymentPlanBillingSvc). Each recognises its own events and ignores the rest.
 *
 * The event is recorded as handled (StripeWebhookEvent) only after every service has applied it. If
 * one throws, nothing is recorded, the webhook answers 500 and Stripe's retry runs them all again —
 * each is idempotent, so what already applied isn't applied twice. Recording first would make that
 * retry look like a duplicate and lose the event, and nobody polls a subscription renewal.
 */
export default class StripeWebhookSvc {
  static async handle(event: Stripe.Event): Promise<{ duplicate: boolean }> {
    if (await ClientPaymentRepo.isWebhookEventRecorded(event.id)) return { duplicate: true };
    await ClientBillingSvc.handleStripeEvent(event);
    await AccountTopUpBillingSvc.handleStripeEvent(event);
    await PaymentPlanBillingSvc.handleStripeEvent(event);
    await ClientPaymentRepo.recordWebhookEvent(event.id, event.type);
    return { duplicate: false };
  }

  /** The Connect endpoint's events (lawyers' connected accounts): only the wallet acts on them. */
  static async handleConnect(event: Stripe.Event): Promise<{ duplicate: boolean }> {
    if (await ClientPaymentRepo.isWebhookEventRecorded(event.id)) return { duplicate: true };
    await WalletSvc.applyConnectEvent(event);
    await ClientPaymentRepo.recordWebhookEvent(event.id, event.type);
    return { duplicate: false };
  }
}
