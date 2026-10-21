import crypto from "crypto";
import type Stripe from "stripe";
import { LAWYER_PAYMENT_PROVIDER } from "../config";
import { stripeClient } from "./stripe-client";

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
 * The per-case fee (ilovelawyer-api#513) charges the card through the same provider.
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

export interface ImmediateOrganizationCardProvider {
  readonly name: "DUMMY";
  readonly mode: "immediate";
  testCard(): SavedCard;
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
}

export type OrganizationCardProvider = ImmediateOrganizationCardProvider | HostedOrganizationCardProvider;

/** metadata.purpose on our setup sessions, which tells the shared webhook they're a card setup. */
export const ORGANIZATION_CARD_PURPOSE = "organization_card";

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
};

let override: OrganizationCardProvider | null = null;

export function organizationCardProvider(): OrganizationCardProvider {
  if (override) return override;
  return LAWYER_PAYMENT_PROVIDER === "stripe" ? stripeOrganizationCardProvider : dummyOrganizationCardProvider;
}

/** Tests only; null goes back to the configured provider. */
export function setOrganizationCardProvider(next: OrganizationCardProvider | null): void {
  override = next;
}
