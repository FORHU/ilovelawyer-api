import crypto from "crypto";
import Stripe from "stripe";
import { LAWYER_PAYMENT_PROVIDER } from "../config";
import { stripeClient } from "./stripe-client";
import { refundResultOf, type ClientRefundResult } from "./client-refunds";

/**
 * Saves an organization's card on file (OrganizationCardSvc). Two providers, chosen by
 * LAWYER_PAYMENT_PROVIDER:
 *
 *  - DUMMY ("immediate"): saves a test card on the spot, with no page to visit. The default, for
 *    local and dev.
 *  - STRIPE ("hosted"): a Stripe Checkout Session in setup mode. The lawyer types the card into
 *    Stripe's own page, so no card data reaches this API; the card is read back from Stripe once the
 *    session completes (the webhook, or the app coming back to its returnUrl).
 *
 * Charges (OrganizationChargeSvc: the per-case fee, #513) go through the provider the card was saved
 * with: a DUMMY test card is never charged for real, even on a server since switched to Stripe.
 */
export interface SavedCard {
  customerId: string | null;
  paymentMethodId: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

export interface CardSetupRequest {
  organizationId: string;
  organizationName: string;
  /** The organization's Stripe customer, null on its first setup. */
  customerId: string | null;
  email: string | null;
  userId: string;
  successUrl: string;
  cancelUrl: string;
}

/** A Checkout Session's card, once it has completed, with who started it. */
export interface CompletedCardSetup {
  sessionId: string;
  organizationId: string;
  userId: string | null;
  card: SavedCard;
}

/** One attempt at charging the card on file, off-session (the lawyer isn't there to confirm it). */
export interface CardChargeRequest {
  /** Our OrganizationCharge id and attempt number: together the idempotency key, so a network retry
   * of this attempt can't charge twice. */
  chargeId: string;
  attempt: number;
  customerId: string | null;
  paymentMethodId: string;
  amountMinor: number;
  currency: string;
  description: string;
  metadata: Record<string, string>;
}

export interface CardChargeResult {
  /** PENDING: the provider is still working on it (a bank that settles later); its webhook ends it. */
  status: "SUCCEEDED" | "PENDING" | "FAILED";
  paymentIntentId: string | null;
  receiptUrl: string | null;
  failureReason: string | null;
}

export interface ImmediateOrganizationCardProvider {
  readonly name: "DUMMY";
  readonly mode: "immediate";
  testCard(): SavedCard;
  charge(request: CardChargeRequest): Promise<CardChargeResult>;
}

export interface HostedOrganizationCardProvider {
  readonly name: "STRIPE";
  readonly mode: "hosted";
  /** Makes the organization's customer when it has none. Returns Stripe's page to send the user to. */
  startSetup(request: CardSetupRequest): Promise<{ url: string; customerId: string; sessionId: string }>;
  /** Null while the session hasn't completed, or when it isn't one of ours. */
  completedSetup(sessionId: string): Promise<CompletedCardSetup | null>;
  /** Makes the card the customer's default and removes the one it replaces. */
  makeDefault(customerId: string, paymentMethodId: string, replaced: string | null): Promise<void>;
  charge(request: CardChargeRequest): Promise<CardChargeResult>;
  /** Where one of our payments stands now, read fresh (webhook events can arrive out of order). */
  chargeStatus(paymentIntentId: string): Promise<CardChargeResult>;
  /** Gives back some or all of a charge (#520). A test card's charge took no money, so only Stripe
   * refunds. */
  refund(request: ChargeRefundRequest): Promise<ClientRefundResult>;
}

export interface ChargeRefundRequest {
  /** Our OrganizationChargeRefund id: the idempotency key, and handed back on the refund webhooks. */
  refundId: string;
  chargeId: string;
  paymentIntentId: string;
  amountMinor: number;
}

export type OrganizationCardProvider = ImmediateOrganizationCardProvider | HostedOrganizationCardProvider;

/** metadata.purpose on our setup sessions, which tells the shared webhook they're a card setup. */
export const ORGANIZATION_CARD_PURPOSE = "organization_card";
/** metadata.purpose on our charges' PaymentIntents, which tells the shared webhook to settle one. */
export const ORGANIZATION_CHARGE_PURPOSE = "organization_charge";
/** metadata.purpose on refunds of those charges, which tells refund.updated whose refund it is. */
export const ORGANIZATION_REFUND_PURPOSE = "organization_refund";

const NEEDS_AUTHENTICATION = "The bank wants the cardholder to approve this payment, which can't be done off-session. Add the card again (or another one) and retry.";

/** A PaymentIntent as one of our charge results. requires_action means the bank wants the
 * cardholder present (3-D Secure), which an off-session charge can't do: it's a failure the lawyer
 * fixes by adding the card again. */
export function chargeResultOf(intent: Pick<Stripe.PaymentIntent, "id" | "status" | "last_payment_error" | "latest_charge">): CardChargeResult {
  const receiptUrl = intent.latest_charge && typeof intent.latest_charge !== "string" ? (intent.latest_charge.receipt_url ?? null) : null;
  if (intent.status === "succeeded") return { status: "SUCCEEDED", paymentIntentId: intent.id, receiptUrl, failureReason: null };
  if (intent.status === "processing") return { status: "PENDING", paymentIntentId: intent.id, receiptUrl: null, failureReason: null };
  const failureReason = intent.status === "requires_action" ? NEEDS_AUTHENTICATION : (intent.last_payment_error?.message ?? "The card was declined.");
  return { status: "FAILED", paymentIntentId: intent.id, receiptUrl: null, failureReason };
}

export const dummyOrganizationCardProvider: ImmediateOrganizationCardProvider = {
  name: "DUMMY",
  mode: "immediate",
  testCard: () => ({
    customerId: null,
    paymentMethodId: `dummy_pm_${crypto.randomUUID()}`,
    brand: "visa",
    last4: "4242",
    expMonth: 12,
    expYear: new Date().getUTCFullYear() + 3,
  }),
  // A test card takes no money: every charge goes through at once.
  async charge(request) {
    return { status: "SUCCEEDED", paymentIntentId: `dummy_pi_${request.chargeId}_${request.attempt}`, receiptUrl: null, failureReason: null };
  },
};

export const stripeOrganizationCardProvider: HostedOrganizationCardProvider = {
  name: "STRIPE",
  mode: "hosted",
  async startSetup(request) {
    const stripe = stripeClient();
    const metadata = { purpose: ORGANIZATION_CARD_PURPOSE, organizationId: request.organizationId, userId: request.userId };
    const customerId =
      request.customerId ??
      (
        await stripe.customers.create(
          { name: request.organizationName, ...(request.email ? { email: request.email } : {}), metadata: { organizationId: request.organizationId } },
          // Two admins starting a first setup at once get the same customer.
          { idempotencyKey: `organization-customer-${request.organizationId}` },
        )
      ).id;
    const session = await stripe.checkout.sessions.create({
      mode: "setup",
      customer: customerId,
      payment_method_types: ["card"],
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
      metadata,
      setup_intent_data: { metadata },
    });
    if (!session.url) throw new Error("Stripe didn't return a page for the card setup");
    return { url: session.url, customerId, sessionId: session.id };
  },
  async completedSetup(sessionId) {
    const session = await stripeClient().checkout.sessions.retrieve(sessionId, { expand: ["setup_intent.payment_method"] });
    if (session.mode !== "setup" || session.metadata?.purpose !== ORGANIZATION_CARD_PURPOSE || !session.metadata.organizationId) return null;
    if (session.status !== "complete") return null;
    const intent = session.setup_intent as Stripe.SetupIntent | null;
    if (!intent || intent.status !== "succeeded" || !intent.payment_method) return null;
    const method = intent.payment_method as Stripe.PaymentMethod;
    return {
      sessionId,
      organizationId: session.metadata.organizationId,
      userId: session.metadata.userId || null,
      card: {
        customerId: typeof session.customer === "string" ? session.customer : (session.customer?.id ?? null),
        paymentMethodId: method.id,
        brand: method.card?.brand ?? null,
        last4: method.card?.last4 ?? null,
        expMonth: method.card?.exp_month ?? null,
        expYear: method.card?.exp_year ?? null,
      },
    };
  },
  async makeDefault(customerId, paymentMethodId, replaced) {
    const stripe = stripeClient();
    await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } });
    if (replaced && replaced !== paymentMethodId) await stripe.paymentMethods.detach(replaced);
  },
  async charge(request) {
    try {
      const intent = await stripeClient().paymentIntents.create(
        {
          amount: request.amountMinor,
          currency: request.currency.toLowerCase(),
          ...(request.customerId ? { customer: request.customerId } : {}),
          payment_method: request.paymentMethodId,
          off_session: true,
          confirm: true,
          description: request.description,
          metadata: { ...request.metadata, purpose: ORGANIZATION_CHARGE_PURPOSE, chargeId: request.chargeId },
          expand: ["latest_charge"],
        },
        { idempotencyKey: `organization-charge-${request.chargeId}-${request.attempt}` },
      );
      return chargeResultOf(intent);
    } catch (err) {
      // A decline (or a card that needs the cardholder) comes back as an error carrying the intent.
      if (err instanceof Stripe.errors.StripeCardError) {
        const intent = err.payment_intent;
        const needsAction = err.code === "authentication_required";
        return {
          status: "FAILED",
          paymentIntentId: intent?.id ?? null,
          receiptUrl: null,
          failureReason: needsAction ? NEEDS_AUTHENTICATION : err.message,
        };
      }
      throw err;
    }
  },
  async chargeStatus(paymentIntentId) {
    return chargeResultOf(await stripeClient().paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] }));
  },
  async refund(request) {
    const refund = await stripeClient().refunds.create(
      {
        payment_intent: request.paymentIntentId,
        amount: request.amountMinor,
        metadata: { purpose: ORGANIZATION_REFUND_PURPOSE, refundId: request.refundId, chargeId: request.chargeId },
      },
      // A retried request (a network blip) can't refund twice.
      { idempotencyKey: `organization-refund-${request.refundId}` },
    );
    return refundResultOf(refund);
  },
};

let override: OrganizationCardProvider | null = null;

export function organizationCardProvider(): OrganizationCardProvider {
  if (override) return override;
  return LAWYER_PAYMENT_PROVIDER === "stripe" ? stripeOrganizationCardProvider : dummyOrganizationCardProvider;
}

/** The provider a saved card belongs to (OrganizationBilling.provider), for charging it. A test's
 * override stands in for the provider of the same name. */
export function organizationCardProviderNamed(name: string): OrganizationCardProvider {
  if (override && override.name === name) return override;
  return name === "STRIPE" ? stripeOrganizationCardProvider : dummyOrganizationCardProvider;
}

/** Tests only; null goes back to the configured provider. */
export function setOrganizationCardProvider(next: OrganizationCardProvider | null): void {
  override = next;
}
