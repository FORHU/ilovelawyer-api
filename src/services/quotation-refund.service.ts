import type { QuotationPayment, QuotationRefund } from "@prisma/client";
import QuotationPaymentRepo, { PAID_QUOTATION_PAYMENT_STATUSES } from "../repositories/quotation-payment.repository";
import SecurityAuditSvc from "./security-audit.service";
import WalletSvc from "./wallet.service";
import { quotationPaymentProviderNamed } from "../payments/quotation-payment-provider";
import { stripeRefused } from "../payments/stripe-client";
import prisma from "../lib/prisma";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

const gbp = (minor: number) => `£${(minor / 100).toFixed(2)}`;

/** Who is giving the money back: an admin, or ilovelawyer itself (a Lawyer Exit with no work done,
 * or a payment that came in after its request moved on). */
export type RefundActor = { adminId: string } | "SYSTEM";

/** A refund recorded and sent to the payment provider, with what the provider said. PENDING: no
 * answer yet (Stripe's refund.updated settles it). */
export interface IssuedRefund {
  refund: QuotationRefund;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  failureReason: string | null;
}

/**
 * Giving a client's quotation payment back (QuotationRefund), whoever decides it. A full refund (all
 * that's left) gives back the platform fee too; anything less comes out of the lawyer's service fee
 * only, so it can be at most what's left of that, and the platform fee is kept. The lawyer's earning
 * is reversed by the service-fee part once the refund goes through. Every refund is audited with its
 * reason: admin.quotation_payment.refunded, or system.quotation_payment.refunded with no admin.
 */
export default class QuotationRefundSvc {
  /** What can still be refunded: all of it (`left`), and of it the lawyer's share (`serviceLeft`).
   * Refunds on their way count as given, so a retry can't refund the same money twice. */
  static async refundable(payment: QuotationPayment): Promise<{ left: number; serviceLeft: number }> {
    const so = await QuotationPaymentRepo.refundedSoFar(payment.id);
    return { left: payment.amountMinor - so.amountMinor, serviceLeft: payment.serviceFeeMinor - so.serviceFeeMinor };
  }

  /**
   * Checks a refund of `amountMinor` (everything left when null) on `payment` can be made now, and
   * returns the amount. 409 NOT_REFUNDABLE when it took no money, is refunded already, or is disputed
   * (Stripe refuses refunds on a disputed charge: the bank decides); 400 REFUND_EXCEEDS_CHARGE past
   * what's left, or, for a partial refund, past what's left of the lawyer's fee.
   */
  static async assertRefundable(payment: QuotationPayment, amountMinor: number | null): Promise<number> {
    if (!PAID_QUOTATION_PAYMENT_STATUSES.includes(payment.status) || payment.status === "REFUNDED") {
      throw new HttpError("Only a payment that took money, and isn't fully refunded, can be refunded.", 409, "NOT_REFUNDABLE");
    }
    if (payment.status === "DISPUTED") throw new HttpError("This payment is disputed: the client's bank decides the outcome.", 409, "NOT_REFUNDABLE");
    // Checked here for a clear answer, and again under the lock (createRefund), which also splits it.
    const { left, serviceLeft } = await QuotationRefundSvc.refundable(payment);
    const amount = amountMinor ?? left;
    if (amount <= 0 || amount > left) throw new HttpError(`At most ${gbp(left)} is left to refund.`, 400, "REFUND_EXCEEDS_CHARGE");
    // Everything that's left: the platform fee comes back too. Less: only the lawyer's part.
    if (amount !== left && amount > serviceLeft) {
      throw new HttpError(`A partial refund comes out of the lawyer's fee: at most ${gbp(serviceLeft)}. Refund ${gbp(left)} to give back everything.`, 400, "REFUND_EXCEEDS_CHARGE");
    }
    return amount;
  }

  /**
   * Records a refund of `amountMinor` PENDING and sends it through the provider the payment was taken
   * with. Refused there: FAILED. No answer: left PENDING, so refund.updated can settle it, and what
   * it holds back stops a retry from refunding the same money twice. Audited. Null when another
   * refund changed what's left first (the amount no longer fits). Doesn't check the payment can be
   * refunded: assertRefundable first.
   */
  static async issue(payment: QuotationPayment, amountMinor: number, reason: string, actor: RefundActor): Promise<IssuedRefund | null> {
    const refund = await QuotationPaymentRepo.createRefund(payment.id, { amountMinor, reason, createdById: actor === "SYSTEM" ? null : actor.adminId });
    if (!refund) return null;

    let result: { status: "PENDING" | "SUCCEEDED" | "FAILED"; externalId: string | null; failureReason: string | null };
    try {
      result = await quotationPaymentProviderNamed(payment.provider).refund({ refundId: refund.id, paymentId: payment.id, paymentIntentId: payment.paymentIntentId ?? "", amountMinor });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (stripeRefused(err)) {
        result = { status: "FAILED", externalId: null, failureReason: message };
        logger.error("Quotation payment refund refused", { paymentId: payment.id, refundId: refund.id, err: message });
      } else {
        result = { status: "PENDING", externalId: null, failureReason: null };
        logger.error("Quotation payment refund: no answer from Stripe, left PENDING for its webhook", { paymentId: payment.id, refundId: refund.id, err: message });
      }
    }
    if (result.status === "PENDING") {
      if (result.externalId) await prisma.quotationRefund.update({ where: { id: refund.id }, data: { externalId: result.externalId } });
    } else {
      const settled = await QuotationPaymentRepo.settleRefund(refund.id, { status: result.status, externalId: result.externalId, failureReason: result.failureReason });
      if (settled?.walletId) await WalletSvc.changedById(settled.walletId);
    }

    await SecurityAuditSvc.record({
      action: actor === "SYSTEM" ? "system.quotation_payment.refunded" : "admin.quotation_payment.refunded",
      actorId: actor === "SYSTEM" ? null : actor.adminId,
      organizationId: null,
      targetType: "quotation_payment",
      targetId: payment.id,
      payload: { requestId: payment.requestId, refundId: refund.id, amountMinor, serviceFeeMinor: refund.serviceFeeMinor, status: result.status, reason },
    });
    return { refund, status: result.status, failureReason: result.failureReason };
  }
}
