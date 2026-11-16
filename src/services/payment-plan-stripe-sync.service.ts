import type { PaymentPlan } from "@prisma/client";
import prisma from "../lib/prisma";
import { stripeClient } from "../payments/stripe-client";
import logger from "../utils/logger";
import { planPrice } from "../constants/payment-plan.constants";

/**
 * Keeps a tier's Stripe Product and monthly Price in step with its price (priceMinor in its
 * currency: USD, or KRW on KR, which Stripe treats as zero-decimal, so whole won go to Stripe as
 * they are). Run lazily, when a
 * checkout needs the Price — never on an admin save — so a Stripe outage never blocks an admin edit
 * and a server without Stripe keys never calls it.
 *
 * A fee change mints a new Price and archives the old one. Existing subscribers stay on the Price
 * they signed up at: an admin's fee edit only reaches new checkouts. (includedAllowanceUsd and
 * caseLimit aren't in Stripe at all; they're read live and apply to everyone at once.)
 */
export default class PaymentPlanStripeSyncSvc {
  /** The Price id a new checkout for this tier should use. */
  static async ensureStripePrice(plan: PaymentPlan): Promise<string> {
    const { amountMinor, currency } = planPrice(plan);
    // A currency change (the payment_plan_currency migration, PaymentPlanSvc.changeCurrency) clears
    // stripePriceAmountMinor, so a Price in the old currency never matches here.
    if (plan.stripePriceId && plan.stripePriceAmountMinor === amountMinor) return plan.stripePriceId;

    const stripe = stripeClient();
    const productId =
      plan.stripeProductId ??
      (
        await stripe.products.create(
          { name: `ilovelawyer ${plan.name}`, metadata: { paymentPlanId: plan.id, tenantId: plan.tenantId, code: plan.code } },
          { idempotencyKey: `payment-plan-product-${plan.id}` },
        )
      ).id;
    // The previous Price is in the key: a fee changed back to an earlier amount gets a fresh Price,
    // not the archived one Stripe would otherwise hand back for the same key.
    const price = await stripe.prices.create(
      { product: productId, currency: currency.toLowerCase(), unit_amount: amountMinor, recurring: { interval: "month" }, metadata: { paymentPlanId: plan.id } },
      { idempotencyKey: `payment-plan-price-${plan.id}-${currency}-${amountMinor}-${plan.stripePriceId ?? "first"}` },
    );
    if (plan.stripePriceId) {
      await stripe.prices.update(plan.stripePriceId, { active: false }).catch((err) => {
        logger.warn("Couldn't archive a tier's old Stripe Price", { paymentPlanId: plan.id, priceId: plan.stripePriceId, err: err instanceof Error ? err.message : String(err) });
      });
    }
    await prisma.paymentPlan.update({ where: { id: plan.id }, data: { stripeProductId: productId, stripePriceId: price.id, stripePriceAmountMinor: amountMinor } });
    return price.id;
  }
}
