import type { ClientPayment } from "@prisma/client";
import type Stripe from "stripe";
import ClientPaymentRepo from "../repositories/client-payment.repository";
import { clientPaymentProvider, outcomeOfSession, type ClientCheckout } from "../payments/client-payment-provider";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { CLIENT_URL, USER_APP_URL } from "../config";
import {
  CLIENT_CASE_CREDITS,
  CLIENT_CASE_PRICE_MINOR,
  CLIENT_CURRENCY,
  CLIENT_DEFAULT_TOP_UP_PACK,
  CLIENT_PROMOS,
  CLIENT_TOP_UP_PACKS,
} from "../constants/client-pricing.constants";

const money = (amountMinor: number) => ({ amountMinor, currency: CLIENT_CURRENCY });

type TestOutcome = "decline" | undefined;

const EXPIRED_REASON = "The payment page expired before you paid. Nothing was charged.";
const FAILED_REASON = "Your payment didn't go through. Nothing was charged.";

/** What the app needs to show Stripe's payment form, or null when the payment already settled. */
function checkoutDto(checkout: ClientCheckout | null) {
  return checkout ? { provider: "STRIPE" as const, clientSecret: checkout.clientSecret, publishableKey: checkout.publishableKey } : null;
}

/** The client app origin Stripe should send the client back to: the caller's own when it's a known
 * app origin (USER_APP_URL, or CLIENT_URL, which CORS already checked it against), else the first
 * USER_APP_URL. */
export function returnOrigin(requestOrigin: string | undefined): string {
  const origin = requestOrigin?.replace(/\/$/, "");
  if (origin && (USER_APP_URL.includes(origin) || CLIENT_URL.includes(origin))) return origin;
  if (USER_APP_URL[0]) return USER_APP_URL[0];
  throw new HttpError("USER_APP_URL isn't set, so there's nowhere to come back to after paying", 500, "USER_APP_URL_MISSING");
}

export interface StartedPayment {
  payment: ClientPayment;
  checkout: ClientCheckout | null;
}

/**
 * Paying for the client app: one payment per new case, and credit top-ups on a case. Chat credits
 * live on the case (Case.clientCredits), and each message to the AI takes one (spendCredit).
 *
 * Every payment goes through clientPaymentProvider() (payments/client-payment-provider.ts) and is
 * stored as a ClientPayment, failed ones included. The dummy settles at once. Stripe starts PENDING
 * with a checkout the app shows; the payment settles on Stripe's webhook (handleStripeEvent) or when
 * the app asks after the client paid (paymentStatus), whichever comes first. A PENDING case payment
 * can't create a case, and a PENDING top-up adds no credits, until it's paid.
 */
export default class ClientBillingSvc {
  static pricing() {
    return {
      case: { price: money(CLIENT_CASE_PRICE_MINOR), credits: CLIENT_CASE_CREDITS },
      topUpPacks: CLIENT_TOP_UP_PACKS.map((p) => ({ id: p.id, name: p.name, credits: p.credits, price: money(p.priceMinor) })),
      defaultPackId: CLIENT_DEFAULT_TOP_UP_PACK,
    };
  }

  /** What a new case costs this client, with a promo code applied if it can be. */
  static async quoteCase(userId: string, promoCode?: string) {
    const price = CLIENT_CASE_PRICE_MINOR;
    const quote = (discountMinor: number, promo: { code: string; applied: boolean; message: string } | null) => ({
      price: money(price),
      discount: money(discountMinor),
      total: money(price - discountMinor),
      promo,
    });
    const code = promoCode?.trim();
    if (!code) return quote(0, null);

    const promo = CLIENT_PROMOS.find((p) => p.code.toLowerCase() === code.toLowerCase());
    if (!promo) return quote(0, { code, applied: false, message: "That code isn't valid." });
    if (promo.firstCaseOnly && (await ClientPaymentRepo.hasPaidForCase(userId))) {
      return quote(0, { code: promo.code, applied: false, message: `${promo.code} only applies to your first case.` });
    }
    return quote(Math.min(promo.discountMinor, price), { code: promo.code, applied: true, message: `${promo.code} applied: ${promo.description}.` });
  }

  /** Pays for a new case. The payment is then used up creating it (ClientCaseSvc.create). A code
   * that doesn't apply is refused rather than silently charging the full price. */
  static async payForCase(userId: string, input: { promoCode?: string; testOutcome?: TestOutcome; origin?: string }) {
    const quote = await ClientBillingSvc.quoteCase(userId, input.promoCode);
    if (quote.promo && !quote.promo.applied) throw new HttpError(quote.promo.message, 400, "PROMO_NOT_APPLIED");
    const { payment, checkout } = await ClientBillingSvc.start(userId, {
      kind: "CASE",
      caseId: null,
      amountMinor: quote.total.amountMinor,
      credits: CLIENT_CASE_CREDITS,
      promoCode: quote.promo?.code ?? null,
      description: "New case on ilovelawyer",
      testOutcome: input.testOutcome,
      origin: input.origin,
    });
    return { paymentId: payment.id, status: payment.status, amount: money(payment.amountMinor), credits: payment.credits, checkout: checkoutDto(checkout) };
  }

  /** The caller has already checked the case is this client's. */
  /** The caller has already checked the case is this client's. With the dummy the credits are added
   * now; with Stripe they're added when the payment settles, so `credits` is the balance as it
   * stands (unchanged until then). */
  static async topUp(userId: string, caseId: string, input: { packId: string; testOutcome?: TestOutcome; origin?: string }) {
    const pack = CLIENT_TOP_UP_PACKS.find((p) => p.id === input.packId);
    if (!pack) throw new HttpError("No such top-up pack", 400);
    const { payment, checkout } = await ClientBillingSvc.start(userId, {
      kind: "TOP_UP",
      caseId,
      amountMinor: pack.priceMinor,
      credits: pack.credits,
      promoCode: null,
      description: `${pack.credits} chat credits on ilovelawyer`,
      testOutcome: input.testOutcome,
      origin: input.origin,
    });
    const credits = payment.status === "SUCCEEDED" ? await ClientPaymentRepo.addCredits(caseId, pack.credits) : await ClientPaymentRepo.creditsOf(caseId);
    return { paymentId: payment.id, status: payment.status, credits, added: pack.credits, amount: money(pack.priceMinor), checkout: checkoutDto(checkout) };
  }

  /**
   * Where one of the client's payments stands. A PENDING Stripe payment is checked with Stripe first
   * and settled if it has moved on, so the app learns the outcome straight after the client pays,
   * without waiting for the webhook (and locally, where no webhook arrives).
   */
  static async paymentStatus(userId: string, paymentId: string) {
    let payment = await ClientPaymentRepo.findForUser(paymentId, userId);
    if (!payment) throw new HttpError("Payment not found", 404);
    if (payment.status === "PENDING" && payment.externalId) {
      await ClientBillingSvc.settleFromStripe(payment);
      payment = (await ClientPaymentRepo.findForUser(paymentId, userId))!;
    }
    return {
      paymentId: payment.id,
      kind: payment.kind,
      status: payment.status,
      amount: money(payment.amountMinor),
      credits: payment.credits,
      caseId: payment.caseId,
      failureReason: payment.failureReason,
      /** A case payment that can still create its case. */
      usable: payment.kind === "CASE" && payment.status === "SUCCEEDED" && !payment.usedAt,
    };
  }

  /**
   * One verified Stripe webhook event (POST /webhooks/stripe). Checkout events settle the payment
   * they name; everything else is acknowledged and ignored. An event already handled is answered
   * without being applied again. An event for a payment this server doesn't have (another
   * environment sharing the Stripe account) is ignored.
   */
  static async handleStripeEvent(event: Stripe.Event): Promise<{ duplicate: boolean }> {
    if (await ClientPaymentRepo.isWebhookEventRecorded(event.id)) return { duplicate: true };
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
      case "checkout.session.async_payment_failed":
      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        const paymentId = session.metadata?.paymentId ?? session.client_reference_id;
        const payment = paymentId ? await ClientPaymentRepo.findById(paymentId) : null;
        if (!payment || payment.provider !== "STRIPE" || payment.externalId !== session.id) {
          logger.info("Stripe webhook: no payment of ours for this session", { eventId: event.id, sessionId: session.id });
          break;
        }
        if (event.type === "checkout.session.async_payment_failed") {
          await ClientPaymentRepo.settle(payment.id, { paid: false, reason: FAILED_REASON });
        } else if (event.type === "checkout.session.expired") {
          await ClientPaymentRepo.settle(payment.id, { paid: false, reason: EXPIRED_REASON });
        } else if (outcomeOfSession(session) === "paid") {
          await ClientPaymentRepo.settle(payment.id, { paid: true });
        }
        break;
      }
      default:
        break;
    }
    await ClientPaymentRepo.recordWebhookEvent(event.id, event.type);
    return { duplicate: false };
  }

  /** Takes one credit for a message to the AI. 402 OUT_OF_CREDITS when there are none. */
  static async spendCredit(caseId: string) {
    if (!(await ClientPaymentRepo.spendCredit(caseId))) {
      throw new HttpError("You're out of chat credits for this case. Top up to keep going.", 402, "OUT_OF_CREDITS");
    }
  }

  /** Gives back the credit of a message the AI never took (it couldn't be queued). */
  static async refundCredit(caseId: string) {
    await ClientPaymentRepo.addCredits(caseId, 1);
  }

  /** Takes a payment through the configured provider and stores it. The dummy (or a payment that
   * comes to nothing after a promo) settles now; Stripe returns a PENDING payment and its checkout. */
  private static async start(
    userId: string,
    p: {
      kind: "CASE" | "TOP_UP";
      caseId: string | null;
      amountMinor: number;
      credits: number;
      promoCode: string | null;
      description: string;
      testOutcome: TestOutcome;
      origin: string | undefined;
    },
  ): Promise<StartedPayment> {
    const provider = clientPaymentProvider();
    const row = {
      userId,
      caseId: p.caseId,
      kind: p.kind,
      amountMinor: p.amountMinor,
      currency: CLIENT_CURRENCY,
      credits: p.credits,
      promoCode: p.promoCode,
    };

    if (provider.mode === "immediate") {
      const result = await provider.charge({ userId, amountMinor: p.amountMinor, currency: CLIENT_CURRENCY, description: p.description, testOutcome: p.testOutcome });
      const payment = await ClientPaymentRepo.create({
        ...row,
        provider: provider.name,
        externalId: result.ok ? result.externalId : null,
        status: result.ok ? "SUCCEEDED" : "FAILED",
        failureReason: result.ok ? null : result.reason,
      });
      if (!result.ok) throw new HttpError(result.reason, 402, "PAYMENT_DECLINED");
      return { payment, checkout: null };
    }

    // Stripe won't take a zero-amount payment; nothing to charge, so it settles now.
    if (p.amountMinor === 0) {
      const payment = await ClientPaymentRepo.create({ ...row, provider: "FREE", externalId: null, status: "SUCCEEDED", failureReason: null });
      return { payment, checkout: null };
    }

    const returnUrl = `${returnOrigin(p.origin)}/payments/return`;
    const pending = await ClientPaymentRepo.create({ ...row, provider: provider.name, externalId: null, status: "PENDING", failureReason: null });
    let checkout: ClientCheckout;
    try {
      checkout = await provider.createCheckout({
        paymentId: pending.id,
        userId,
        customerEmail: await ClientPaymentRepo.findEmail(userId),
        amountMinor: p.amountMinor,
        currency: CLIENT_CURRENCY,
        description: p.description,
        returnUrl: `${returnUrl}?paymentId=${encodeURIComponent(pending.id)}`,
      });
    } catch (err) {
      logger.error("Stripe checkout could not be created", { paymentId: pending.id, err: err instanceof Error ? err.message : String(err) });
      await ClientPaymentRepo.settle(pending.id, { paid: false, reason: "We couldn't open the payment page." });
      if (err instanceof HttpError) throw err;
      throw new HttpError("We couldn't open the payment page. Try again in a moment.", 502, "PAYMENT_PROVIDER_ERROR");
    }
    await ClientPaymentRepo.setExternalId(pending.id, checkout.externalId);
    return { payment: { ...pending, externalId: checkout.externalId }, checkout };
  }

  /** Asks Stripe where a PENDING payment's checkout stands and settles it if it has moved on. A
   * Stripe outage leaves it PENDING (the webhook still settles it later). */
  private static async settleFromStripe(payment: ClientPayment) {
    const provider = clientPaymentProvider();
    if (provider.mode !== "checkout" || payment.provider !== provider.name || !payment.externalId) return;
    try {
      const outcome = await provider.checkoutOutcome(payment.externalId);
      if (outcome === "paid") await ClientPaymentRepo.settle(payment.id, { paid: true });
      else if (outcome === "expired") await ClientPaymentRepo.settle(payment.id, { paid: false, reason: EXPIRED_REASON });
      else if (outcome === "failed") await ClientPaymentRepo.settle(payment.id, { paid: false, reason: FAILED_REASON });
    } catch (err) {
      logger.warn("Stripe checkout status could not be read", { paymentId: payment.id, err: err instanceof Error ? err.message : String(err) });
    }
  }
}
