import OrganizationBillingRepo from "../repositories/organization-billing.repository";
import { organizationCardProvider, type CompletedCardSetup } from "../payments/organization-card-provider";
import SecurityAuditSvc from "./security-audit.service";
import { CLIENT_URL } from "../config";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

/** Adds a query to a URL, ahead of any #fragment. `query` is used as is, so Stripe's
 * {CHECKOUT_SESSION_ID} placeholder survives unencoded. */
export function withQuery(url: string, query: string): string {
  const hashAt = url.indexOf("#");
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  return `${base}${base.includes("?") ? "&" : "?"}${query}${hash}`;
}

/** The returnUrl the lawyer app asked to come back to, if it's on one of its own origins (CLIENT_URL,
 * which CORS already trusts). Anything else is refused, so the setup can't be used to send someone
 * to another site. */
export function allowedReturnUrl(returnUrl: string): string {
  let origin: string;
  try {
    const parsed = new URL(returnUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("not http");
    origin = parsed.origin;
  } catch {
    throw new HttpError("returnUrl isn't a valid URL", 400, "RETURN_URL_NOT_ALLOWED");
  }
  if (!CLIENT_URL.some((allowed) => allowed.replace(/\/$/, "") === origin)) {
    throw new HttpError("returnUrl must be on the app's own address", 400, "RETURN_URL_NOT_ALLOWED");
  }
  return returnUrl;
}

type BillingRow = NonNullable<Awaited<ReturnType<typeof OrganizationBillingRepo.find>>>;

function cardDto(row: BillingRow | null) {
  if (!row?.paymentMethodId) return null;
  return {
    brand: row.brand,
    last4: row.last4,
    expMonth: row.expMonth,
    expYear: row.expYear,
    /** DUMMY: a test card saved by LAWYER_PAYMENT_PROVIDER=dummy, never charged for real. */
    provider: row.provider,
    updatedAt: row.updatedAt,
  };
}

/**
 * A law firm's card on file, which the client hand-off's per-case fee is charged to (#513). Set up
 * through organizationCardProvider(): with Stripe, the lawyer types the card into Stripe's own page
 * (Checkout in setup mode) and only its brand, last 4 and expiry come back here; with the dummy, a
 * test card is saved at once. Organization OWNER/ADMIN only (organization.route.ts).
 */
export default class OrganizationCardSvc {
  /**
   * The card on file, or null. `setupSessionId` is the session the app just came back from: when
   * given, it's applied first if it completed, so the card shows without waiting for the webhook
   * (and locally, where none arrives). A Stripe outage leaves the card as it was.
   */
  static async get(organizationId: string, setupSessionId?: string) {
    const provider = organizationCardProvider();
    if (setupSessionId && provider.mode === "hosted") {
      try {
        await OrganizationCardSvc.applyStripeSetupSession(setupSessionId, organizationId);
      } catch (err) {
        logger.warn("Card setup could not be read from Stripe", { organizationId, setupSessionId, err: err instanceof Error ? err.message : String(err) });
      }
    }
    return cardDto(await OrganizationBillingRepo.find(organizationId));
  }

  /** Whether the organization can be charged (for #511's claim and #513's fee). */
  static async hasCard(organizationId: string): Promise<boolean> {
    return !!(await OrganizationBillingRepo.find(organizationId))?.paymentMethodId;
  }

  /** Starts adding or replacing the card. Returns where to send the user: Stripe's page, or with the
   * dummy straight back to returnUrl with the test card already saved. */
  static async startSetup(organizationId: string, userId: string, returnUrl: string): Promise<{ url: string }> {
    const back = allowedReturnUrl(returnUrl);
    const provider = organizationCardProvider();

    if (provider.mode === "immediate") {
      const card = provider.testCard();
      await OrganizationCardSvc.save({ organizationId, userId, provider: provider.name, card, setupSessionId: null });
      return { url: withQuery(back, "cardSetup=done") };
    }

    const [organization, billing, email] = await Promise.all([
      OrganizationBillingRepo.findOrganization(organizationId),
      OrganizationBillingRepo.find(organizationId),
      OrganizationBillingRepo.findEmail(userId),
    ]);
    if (!organization) throw new HttpError("Organization not found", 404);
    let started;
    try {
      started = await provider.startSetup({
        organizationId,
        organizationName: organization.name,
        // The dummy never makes a customer, so one here is always Stripe's.
        customerId: billing?.customerId ?? null,
        email,
        userId,
        successUrl: withQuery(back, "cardSetup=done&setupSessionId={CHECKOUT_SESSION_ID}"),
        cancelUrl: withQuery(back, "cardSetup=cancelled"),
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      logger.error("Stripe card setup could not be started", { organizationId, err: err instanceof Error ? err.message : String(err) });
      throw new HttpError("We couldn't open the card page. Try again in a moment.", 502, "PAYMENT_PROVIDER_ERROR");
    }
    if (started.customerId !== billing?.customerId) await OrganizationBillingRepo.setCustomer(organizationId, started.customerId);
    return { url: started.url };
  }

  /**
   * Saves the card from a completed Stripe setup session: from the webhook (checkout.session.completed
   * in setup mode), or the app coming back. Applied once per session. `expectedOrganizationId` is the
   * organization the app asked for, so one firm can't apply another's session. Returns whether this
   * call saved it.
   */
  static async applyStripeSetupSession(sessionId: string, expectedOrganizationId?: string): Promise<boolean> {
    const provider = organizationCardProvider();
    if (provider.mode !== "hosted") return false;
    const completed = await provider.completedSetup(sessionId);
    if (!completed) return false;
    if (expectedOrganizationId && completed.organizationId !== expectedOrganizationId) {
      logger.warn("Card setup session belongs to another organization", { sessionId, expectedOrganizationId });
      return false;
    }
    const billing = await OrganizationBillingRepo.find(completed.organizationId);
    if (!billing || (billing.customerId && completed.card.customerId && billing.customerId !== completed.card.customerId)) {
      // Another environment sharing the Stripe account, or a customer this organization no longer uses.
      logger.info("Card setup session isn't for this organization's customer", { sessionId, organizationId: completed.organizationId });
      return false;
    }
    return OrganizationCardSvc.save({
      organizationId: completed.organizationId,
      userId: completed.userId,
      provider: provider.name,
      card: completed.card,
      setupSessionId: completed.sessionId,
      afterSave: async (replaced) => {
        if (!completed.card.customerId) return;
        // Best effort: the card is already on file here; Stripe only needs it as the default.
        try {
          await provider.makeDefault(completed.card.customerId, completed.card.paymentMethodId, replaced?.provider === "STRIPE" ? replaced.paymentMethodId : null);
        } catch (err) {
          logger.warn("Stripe default card could not be updated", { sessionId, err: err instanceof Error ? err.message : String(err) });
        }
      },
    });
  }

  private static async save(input: {
    organizationId: string;
    userId: string | null;
    provider: string;
    card: CompletedCardSetup["card"];
    setupSessionId: string | null;
    afterSave?: (replaced: { provider: string; paymentMethodId: string } | null) => Promise<void>;
  }): Promise<boolean> {
    const { applied, replaced } = await OrganizationBillingRepo.saveCard(input.organizationId, {
      provider: input.provider,
      card: input.card,
      setupSessionId: input.setupSessionId,
      updatedById: input.userId,
    });
    if (!applied) return false;
    await input.afterSave?.(replaced);
    await SecurityAuditSvc.record({
      action: "org.payment_card_updated",
      actorId: input.userId,
      organizationId: input.organizationId,
      targetType: "organization",
      targetId: input.organizationId,
      payload: { provider: input.provider, brand: input.card.brand, last4: input.card.last4, replaced: !!replaced },
    });
    return true;
  }
}
