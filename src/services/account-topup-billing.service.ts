import type { AccountAiTopUp } from "@prisma/client";
import type Stripe from "stripe";
import prisma from "../lib/prisma";
import AccountAiTopUpRepo from "../repositories/account-ai-topup.repository";
import AccountTopUpPricingSvc from "./account-topup-pricing.service";
import { createAccountTopUpCheckout, accountTopUpCheckoutOutcome, ACCOUNT_TOPUP_METADATA_KIND, type AccountTopUpCheckout } from "../payments/account-topup-provider";
import { stripeClient } from "../payments/stripe-client";
import { returnOrigin } from "./client-billing.service";
import { STRIPE_PUBLISHABLE_KEY } from "../config";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

const EXPIRED_REASON = "The payment page expired before you paid. Nothing was charged.";
const FAILED_REASON = "Your payment didn't go through. Nothing was charged.";

function checkoutDto(checkout: AccountTopUpCheckout | null) {
  return checkout ? { provider: "STRIPE" as const, clientSecret: checkout.clientSecret, publishableKey: checkout.publishableKey } : null;
}

async function tenantIdOf(userId: string): Promise<string> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true } });
  if (!row?.tenantId) throw new HttpError("Your account has no region set, so a top-up fee can't be quoted", 409, "USER_NO_TENANT");
  return row.tenantId;
}

/**
 * A lawyer's self-serve top-up of their own account's hidden AI allowance (AccountLimitsSvc), via
 * Stripe Checkout. Separate from ClientBillingSvc (a client paying for their case) — different
 * payer, no credits/promo concepts — but shares its Stripe plumbing: stripeClient(), the webhook
 * mount, and the same checkout/settle/idempotency shape (AccountAiTopUpRepo mirrors ClientPaymentRepo).
 *
 * The underlying allowance ceiling isn't surfaced here as a bare number: quote/startCheckout return
 * only the lawyer's own chosen topUpAmountUsd and the fee on it. (The account's remaining balance
 * and percentage used are shown elsewhere — AccountLimitsSvc.allowanceInfo, GET /api/users/me/ai-allowance.)
 */
export default class AccountTopUpBillingSvc {
  static async quote(userId: string, topUpAmountUsd: number) {
    const tenantId = await tenantIdOf(userId);
    return AccountTopUpPricingSvc.quote(tenantId, topUpAmountUsd);
  }

  static async startCheckout(userId: string, topUpAmountUsd: number, origin: string | undefined) {
    const tenantId = await tenantIdOf(userId);
    const quote = await AccountTopUpPricingSvc.quote(tenantId, topUpAmountUsd);

    // Reuse an already-open checkout for the exact same amount (the lawyer re-opening the modal, or
    // a second tab) instead of starting a second one; a different amount gets its own, and the old
    // session is simply left to expire on its own. Returns the OPEN row's own stored amounts, not a
    // freshly recomputed quote, so the figure shown matches what Stripe will actually charge even if
    // the admin fee changed in between.
    const open = await AccountAiTopUpRepo.findOpenForUser(userId);
    if (open && open.externalId && open.topUpAmountUsd === quote.topUpAmountUsd) {
      const checkout = await AccountTopUpBillingSvc.reopenCheckout(open);
      if (checkout) {
        return { topUpId: open.id, status: open.status, topUpAmountUsd: open.topUpAmountUsd, feeAmountUsd: open.feeAmountUsd, totalChargedUsd: open.totalChargedUsd, checkout: checkoutDto(checkout) };
      }
    }

    const pending = await AccountAiTopUpRepo.create({
      userId,
      topUpAmountUsd: quote.topUpAmountUsd,
      feeAmountUsd: quote.feeAmountUsd,
      totalChargedUsd: quote.totalChargedUsd,
      provider: "STRIPE",
      externalId: null,
      status: "PENDING",
    });

    const returnUrl = `${returnOrigin(origin)}/payments/return`;
    let checkout: AccountTopUpCheckout;
    try {
      checkout = await createAccountTopUpCheckout({
        topUpId: pending.id,
        userId,
        totalChargedUsd: quote.totalChargedUsd,
        customerEmail: await AccountTopUpBillingSvc.emailOf(userId),
        returnUrl: `${returnUrl}?topUpId=${encodeURIComponent(pending.id)}`,
      });
    } catch (err) {
      logger.error("Stripe checkout could not be created for an account AI top-up", { topUpId: pending.id, err: err instanceof Error ? err.message : String(err) });
      await AccountAiTopUpRepo.expire(pending.id, "We couldn't open the payment page.");
      if (err instanceof HttpError) throw err;
      throw new HttpError("We couldn't open the payment page. Try again in a moment.", 502, "PAYMENT_PROVIDER_ERROR");
    }
    await AccountAiTopUpRepo.setExternalId(pending.id, checkout.externalId);
    return { topUpId: pending.id, status: "PENDING" as const, ...quote, checkout: checkoutDto(checkout) };
  }

  /** Where a top-up stands. A PENDING one is checked with Stripe first and settled if it has moved
   * on, so the app learns the outcome right after the lawyer pays, without waiting for the webhook
   * (and locally, where no webhook arrives). */
  static async status(userId: string, topUpId: string) {
    let topUp = await AccountAiTopUpRepo.findForUser(topUpId, userId);
    if (!topUp) throw new HttpError("Top-up not found", 404);
    if (topUp.status === "PENDING" && topUp.externalId) {
      await AccountTopUpBillingSvc.settleFromStripe(topUp);
      topUp = (await AccountAiTopUpRepo.findForUser(topUpId, userId))!;
    }
    return {
      topUpId: topUp.id,
      status: topUp.status,
      topUpAmountUsd: topUp.topUpAmountUsd,
      feeAmountUsd: topUp.feeAmountUsd,
      totalChargedUsd: topUp.totalChargedUsd,
      failureReason: topUp.failureReason,
    };
  }

  /** One verified Stripe webhook event (StripeWebhookSvc has already ruled out a retried delivery).
   * This only decides whether the event is an account AI top-up (metadata.kind === ACCOUNT_TOPUP)
   * and applies it; anything else no-ops. */
  static async handleStripeEvent(event: Stripe.Event): Promise<{ handled: boolean }> {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
      case "checkout.session.async_payment_failed":
      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.metadata?.kind !== ACCOUNT_TOPUP_METADATA_KIND) return { handled: false };
        const topUpId = session.metadata?.topUpId ?? session.client_reference_id;
        const topUp = topUpId ? await AccountAiTopUpRepo.findById(topUpId) : null;
        if (!topUp || topUp.provider !== "STRIPE" || topUp.externalId !== session.id) {
          logger.info("Stripe webhook: no account AI top-up of ours for this session", { eventId: event.id, sessionId: session.id });
          return { handled: true };
        }
        if (event.type === "checkout.session.async_payment_failed") {
          await AccountAiTopUpRepo.settle(topUp.id, { paid: false, reason: FAILED_REASON });
        } else if (event.type === "checkout.session.expired") {
          await AccountAiTopUpRepo.expire(topUp.id, EXPIRED_REASON);
        } else {
          const outcome = await accountTopUpCheckoutOutcome(session.id).catch(() => null);
          if (outcome === "paid") await AccountAiTopUpRepo.settle(topUp.id, { paid: true });
        }
        return { handled: true };
      }
      default:
        return { handled: false };
    }
  }

  private static async reopenCheckout(topUp: AccountAiTopUp): Promise<AccountTopUpCheckout | null> {
    if (!topUp.externalId) return null;
    try {
      const outcome = await accountTopUpCheckoutOutcome(topUp.externalId);
      if (outcome !== "open") return null;
      const session = await stripeClient().checkout.sessions.retrieve(topUp.externalId);
      if (!session.client_secret || !STRIPE_PUBLISHABLE_KEY) return null;
      return { externalId: session.id, clientSecret: session.client_secret, publishableKey: STRIPE_PUBLISHABLE_KEY };
    } catch {
      return null;
    }
  }

  private static async settleFromStripe(topUp: AccountAiTopUp) {
    if (!topUp.externalId) return;
    try {
      const outcome = await accountTopUpCheckoutOutcome(topUp.externalId);
      if (outcome === "paid") await AccountAiTopUpRepo.settle(topUp.id, { paid: true });
      else if (outcome === "expired") await AccountAiTopUpRepo.expire(topUp.id, EXPIRED_REASON);
      else if (outcome === "failed") await AccountAiTopUpRepo.settle(topUp.id, { paid: false, reason: FAILED_REASON });
    } catch (err) {
      logger.warn("Stripe checkout status could not be read for an account AI top-up", { topUpId: topUp.id, err: err instanceof Error ? err.message : String(err) });
    }
  }

  private static async emailOf(userId: string): Promise<string | null> {
    return (await prisma.user.findUnique({ where: { id: userId }, select: { email: true } }))?.email ?? null;
  }
}
