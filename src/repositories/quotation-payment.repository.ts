import type { Earning, Prisma, QuotationPayment, QuotationPaymentStatus, QuotationRefund } from "@prisma/client";
import prisma from "../lib/prisma";
import { createEarningTx, reverseEarningTx } from "./wallet.repository";

/** Rolls a transaction back when the payment or request had already moved on. */
class MovedOn extends Error {}

/** A payment that took money. */
export const PAID_QUOTATION_PAYMENT_STATUSES: QuotationPaymentStatus[] = ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED"];

/** Why the client can't start a payment now. */
export type PaymentRefusal = "CLOSED" | "EXPIRED" | "PAID";

/**
 * The client's payments for accepted quotations (QuotationPayment), their refunds (QuotationRefund)
 * and what a successful one does: the request ENGAGED, the quotation PAID, the claim ENGAGED and the
 * lawyer's earning in their wallet, in one transaction, request row first (REQUEST_ROW_FIRST in
 * client-request-claim.repository.ts).
 */
export default class QuotationPaymentRepo {
  static async findById(id: string) {
    return prisma.quotationPayment.findUnique({ where: { id } });
  }

  static async findByPaymentIntent(paymentIntentId: string) {
    return prisma.quotationPayment.findUnique({ where: { paymentIntentId } });
  }

  /** The newest attempt on a quotation. */
  static async findLatest(quotationId: string) {
    return prisma.quotationPayment.findFirst({ where: { quotationId }, orderBy: { attempt: "desc" } });
  }

  /** Attempts still waiting on the client, for the expiry to cancel. */
  static async findPending(quotationId: string) {
    return prisma.quotationPayment.findMany({ where: { quotationId, status: "PENDING" } });
  }

  /**
   * Starts an attempt at paying an ACCEPTED quotation, before its expiry, while the request is
   * CONFIRMED: a new PENDING payment for the accepted amount, numbered after the last. One already
   * PENDING is returned instead (`existing`), so a double click can't open two.
   */
  static async start(
    quotationId: string,
    input: { clientId: string; provider: string },
    now: Date = new Date(),
  ): Promise<{ payment: QuotationPayment; existing: boolean } | { refused: PaymentRefusal }> {
    return prisma.$transaction(async (tx) => {
      const quotation = await tx.quotation.findUnique({ where: { id: quotationId } });
      if (!quotation) return { refused: "CLOSED" as const };
      const locked = await tx.clientRequest.updateMany({ where: { id: quotation.requestId, status: "CONFIRMED" }, data: { updatedAt: now } });
      const fresh = await tx.quotation.findUniqueOrThrow({ where: { id: quotationId } });
      if (fresh.status === "PAID") return { refused: "PAID" as const };
      if (locked.count !== 1 || fresh.status !== "ACCEPTED" || fresh.acceptedAmountMinor === null) return { refused: "CLOSED" as const };
      if (fresh.expiresAt <= now) return { refused: "EXPIRED" as const };
      const pending = await tx.quotationPayment.findFirst({ where: { quotationId, status: "PENDING" }, orderBy: { attempt: "desc" } });
      if (pending) return { payment: pending, existing: true };
      const last = await tx.quotationPayment.findFirst({ where: { quotationId }, orderBy: { attempt: "desc" }, select: { attempt: true } });
      const payment = await tx.quotationPayment.create({
        data: {
          quotationId,
          requestId: fresh.requestId,
          clientId: input.clientId,
          amountMinor: fresh.acceptedAmountMinor,
          serviceFeeMinor: fresh.serviceFeeMinor,
          platformFeeMinor: fresh.acceptedAmountMinor - fresh.serviceFeeMinor,
          currency: fresh.currency,
          provider: input.provider,
          attempt: (last?.attempt ?? 0) + 1,
          status: "PENDING",
        },
      });
      return { payment, existing: false };
    });
  }

  static async setPaymentIntent(id: string, paymentIntentId: string) {
    await prisma.quotationPayment.updateMany({ where: { id, status: "PENDING" }, data: { paymentIntentId } });
  }

  /** An attempt that ended without money taken: FAILED (declined) or CANCELED. Only while PENDING. */
  static async end(id: string, status: "FAILED" | "CANCELED", reason: string | null): Promise<boolean> {
    const { count } = await prisma.quotationPayment.updateMany({ where: { id, status: "PENDING" }, data: { status, failureReason: reason } });
    return count === 1;
  }

  /**
   * Money was taken: the payment SUCCEEDED (even one we'd marked FAILED or CANCELED: the money is
   * real), and, while the request is still CONFIRMED on this quotation, the request is ENGAGED, the
   * quotation PAID, the claim ENGAGED and the lawyer's earning (the service fee) goes into `walletId`
   * PENDING until `availableAt`. `orphaned`: the money came in after the request had moved on (it
   * expired a moment before), so the caller refunds it. Once: settled is false when it already had.
   */
  static async settle(
    paymentId: string,
    earning: { walletId: string; lawyerId: string; availableAt: Date },
    paymentIntentId: string | null,
    now: Date = new Date(),
  ): Promise<{ settled: false } | { settled: true; engaged: boolean; orphaned: boolean; earning: Earning | null; payment: QuotationPayment }> {
    const payment = await prisma.quotationPayment.findUnique({ where: { id: paymentId } });
    if (!payment) return { settled: false };
    try {
      return await prisma.$transaction(async (tx) => {
        const engaged = (await tx.clientRequest.updateMany({ where: { id: payment.requestId, status: "CONFIRMED" }, data: { status: "ENGAGED", engagedAt: now } })).count === 1;
        const { count } = await tx.quotationPayment.updateMany({
          where: { id: paymentId, status: { in: ["PENDING", "FAILED", "CANCELED"] } },
          data: { status: "SUCCEEDED", succeededAt: now, failureReason: null, ...(paymentIntentId ? { paymentIntentId } : {}) },
        });
        if (count !== 1) throw new MovedOn();
        const settledPayment = await tx.quotationPayment.findUniqueOrThrow({ where: { id: paymentId } });
        if (!engaged) return { settled: true as const, engaged: false, orphaned: true, earning: null, payment: settledPayment };
        const paid = await tx.quotation.updateMany({ where: { id: payment.quotationId, status: "ACCEPTED" }, data: { status: "PAID", paidAt: now } });
        if (paid.count !== 1) throw new MovedOn();
        const quotation = await tx.quotation.findUniqueOrThrow({ where: { id: payment.quotationId } });
        await tx.clientRequestClaim.updateMany({ where: { id: quotation.claimId, outcome: null }, data: { outcome: "ENGAGED", openRequestId: null } });
        const created = await createEarningTx(tx, {
          paymentId,
          walletId: earning.walletId,
          quotationId: quotation.id,
          requestId: quotation.requestId,
          lawyerId: earning.lawyerId,
          grossMinor: payment.amountMinor,
          platformFeeMinor: payment.platformFeeMinor,
          netMinor: payment.serviceFeeMinor,
          currency: payment.currency,
          availableAt: earning.availableAt,
        });
        return { settled: true as const, engaged: true, orphaned: false, earning: created, payment: settledPayment };
      });
    } catch (err) {
      if (err instanceof MovedOn) return { settled: false };
      throw err;
    }
  }

  // ── Refunds ────────────────────────────────────────────────────────────────

  static async findRefund(id: string) {
    return prisma.quotationRefund.findUnique({ where: { id } });
  }

  /** Records a refund PENDING, with the payment row locked, so two admins at once can't give back
   * more than was paid. Null when the payment took no money, or it would be more than is left. */
  static async createRefund(
    paymentId: string,
    input: { amountMinor: number; serviceFeeMinor: number; platformFeeMinor: number; reason: string; createdById: string | null },
  ): Promise<QuotationRefund | null> {
    try {
      return await prisma.$transaction(async (tx) => {
        const locked = await tx.quotationPayment.updateMany({ where: { id: paymentId, status: { in: PAID_QUOTATION_PAYMENT_STATUSES } }, data: { updatedAt: new Date() } });
        if (locked.count !== 1) throw new MovedOn();
        const payment = await tx.quotationPayment.findUniqueOrThrow({ where: { id: paymentId } });
        const { _sum } = await tx.quotationRefund.aggregate({ where: { paymentId, status: { in: ["PENDING", "SUCCEEDED"] } }, _sum: { amountMinor: true } });
        if ((_sum.amountMinor ?? 0) + input.amountMinor > payment.amountMinor) throw new MovedOn();
        return tx.quotationRefund.create({ data: { paymentId, ...input, status: "PENDING" } });
      });
    } catch (err) {
      if (err instanceof MovedOn) return null;
      throw err;
    }
  }

  /** What's been given back or is on its way, split into the lawyer's and the platform's parts. */
  static async refundedSoFar(paymentId: string) {
    const { _sum } = await prisma.quotationRefund.aggregate({
      where: { paymentId, status: { in: ["PENDING", "SUCCEEDED"] } },
      _sum: { amountMinor: true, serviceFeeMinor: true, platformFeeMinor: true },
    });
    return { amountMinor: _sum.amountMinor ?? 0, serviceFeeMinor: _sum.serviceFeeMinor ?? 0, platformFeeMinor: _sum.platformFeeMinor ?? 0 };
  }

  /**
   * Ends a PENDING refund, once. SUCCEEDED: the payment's refunded total goes up (REFUNDED when all of
   * it, else PARTIALLY_REFUNDED) and the lawyer's earning is reversed by the refund's service-fee part,
   * in the same transaction. Returns the wallet that changed, if any; null when it had already ended.
   */
  static async settleRefund(refundId: string, result: { status: "SUCCEEDED" | "FAILED"; externalId: string | null; failureReason: string | null }) {
    try {
      return await prisma.$transaction(async (tx) => {
        const { count } = await tx.quotationRefund.updateMany({
          where: { id: refundId, status: "PENDING" },
          data: { status: result.status, failureReason: result.failureReason, ...(result.externalId ? { externalId: result.externalId } : {}) },
        });
        if (count !== 1) throw new MovedOn();
        const refund = await tx.quotationRefund.findUniqueOrThrow({ where: { id: refundId } });
        if (result.status !== "SUCCEEDED") return { refund, walletId: null as string | null };
        const payment = await tx.quotationPayment.findUniqueOrThrow({ where: { id: refund.paymentId } });
        const refundedMinor = payment.refundedMinor + refund.amountMinor;
        await tx.quotationPayment.update({
          where: { id: payment.id },
          data: { refundedMinor, ...(payment.status === "DISPUTED" ? {} : { status: refundedMinor >= payment.amountMinor ? "REFUNDED" : "PARTIALLY_REFUNDED" }) },
        });
        const earning = await tx.earning.findUnique({ where: { paymentId: payment.id }, select: { id: true } });
        const reversed = earning && refund.serviceFeeMinor > 0 ? await reverseEarningTx(tx, earning.id, refund.serviceFeeMinor, `refund:${refund.id}`, "Refunded to the client") : null;
        return { refund, walletId: reversed?.walletId ?? null };
      });
    } catch (err) {
      if (err instanceof MovedOn) return null;
      throw err;
    }
  }

  // ── Disputes ───────────────────────────────────────────────────────────────

  /** The client's bank opened a dispute: the payment is DISPUTED and its earning held back from
   * release until it's decided. */
  static async openDispute(paymentId: string) {
    await prisma.$transaction([
      prisma.quotationPayment.updateMany({ where: { id: paymentId, status: { in: ["SUCCEEDED", "PARTIALLY_REFUNDED"] } }, data: { status: "DISPUTED" } }),
      prisma.earning.updateMany({ where: { paymentId }, data: { disputed: true } }),
    ]);
  }

  /** The dispute was decided. Won: the payment is back to SUCCEEDED (or PARTIALLY_REFUNDED) and its
   * earning released as normal. Lost: the bank took the money back, so what's left of the earning is
   * reversed out of the wallet. Returns the wallet that changed, if any. */
  static async closeDispute(paymentId: string, won: boolean, disputeId: string): Promise<string | null> {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const payment = await tx.quotationPayment.findUnique({ where: { id: paymentId } });
      if (!payment || payment.status !== "DISPUTED") return null;
      const earning = await tx.earning.findUnique({ where: { paymentId } });
      if (won) {
        await tx.quotationPayment.update({ where: { id: paymentId }, data: { status: payment.refundedMinor > 0 ? "PARTIALLY_REFUNDED" : "SUCCEEDED" } });
        if (earning) await tx.earning.update({ where: { id: earning.id }, data: { disputed: false } });
        return null;
      }
      await tx.quotationPayment.update({ where: { id: paymentId }, data: { status: "REFUNDED", refundedMinor: payment.amountMinor } });
      if (!earning) return null;
      await tx.earning.update({ where: { id: earning.id }, data: { disputed: false } });
      const reversed = await reverseEarningTx(tx, earning.id, earning.netMinor, `dispute:${disputeId}`, "Taken back by the client's bank (dispute lost)");
      return reversed?.walletId ?? null;
    });
  }

  // ── Admin ──────────────────────────────────────────────────────────────────

  /** Payments that took money (and the attempts that didn't, when `status` asks for them), newest first. */
  static async list(where: Prisma.QuotationPaymentWhereInput, page: number, limit: number) {
    const [total, data] = await prisma.$transaction([
      prisma.quotationPayment.count({ where }),
      prisma.quotationPayment.findMany({ where, include: { refunds: { orderBy: { createdAt: "desc" } } }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * limit, take: limit }),
    ]);
    return { total, data };
  }
}
