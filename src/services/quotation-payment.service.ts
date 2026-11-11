import type Stripe from "stripe";
import type { LawyerExit, Quotation, QuotationPayment, QuotationRefund } from "@prisma/client";
import QuotationRepo from "../repositories/quotation.repository";
import QuotationPaymentRepo, { PAID_QUOTATION_PAYMENT_STATUSES } from "../repositories/quotation-payment.repository";
import LawyerExitRepo from "../repositories/lawyer-exit.repository";
import WalletRepo from "../repositories/wallet.repository";
import ClientRequestRepo from "../repositories/client-request.repository";
import ClientPaymentRepo from "../repositories/client-payment.repository";
import OrganizationRepo from "../repositories/organization.repository";
import EngagementAccessSvc from "./engagement-access.service";
import NotificationSvc from "./notification.service";
import QuotationRefundSvc from "./quotation-refund.service";
import LawyerExitSvc from "./lawyer-exit.service";
import WalletSvc, { payeeOf } from "./wallet.service";
import { quotationPaymentProvider, quotationPaymentProviderNamed, type QuotationPaymentResult } from "../payments/quotation-payment-provider";
import { emitToUser } from "../lib/socket";
import prisma from "../lib/prisma";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import type { ClientRequestUpdatedEvent } from "../types/client-handoff";

const UNREACHABLE = "We couldn't reach the payment provider. Try again in a moment.";
const gbp = (minor: number) => `£${(minor / 100).toFixed(2)}`;
const money = (amountMinor: number, currency: string) => ({ amountMinor, currency });

/** QuotationPayment in the contract, for the client app. */
export function paymentDto(p: QuotationPayment) {
  return {
    id: p.id,
    quotationId: p.quotationId,
    status: p.status,
    amount: money(p.amountMinor, p.currency),
    serviceFee: money(p.serviceFeeMinor, p.currency),
    platformFee: money(p.platformFeeMinor, p.currency),
    refunded: money(p.refundedMinor, p.currency),
    provider: p.provider,
    failureReason: p.failureReason,
    succeededAt: p.succeededAt,
    createdAt: p.createdAt,
  };
}

function refundDto(r: QuotationRefund, currency: string) {
  return {
    id: r.id,
    status: r.status,
    amount: money(r.amountMinor, currency),
    serviceFee: money(r.serviceFeeMinor, currency),
    platformFee: money(r.platformFeeMinor, currency),
    reason: r.reason,
    failureReason: r.failureReason,
    createdAt: r.createdAt,
  };
}

async function notify(userId: string, n: { title: string; message: string; link: string }) {
  await NotificationSvc.create({ userId, type: "CLIENT_REQUEST", ...n }).catch((err) => logger.error("Quotation payment: failed to create notification", { err, userId }));
}

/**
 * The client paying a lawyer's accepted quotation through ilovelawyer (QuotationPayment), and what a
 * payment does once it's in: the request ENGAGED, the lawyer given read-only access to the case, and
 * their service fee in their wallet, PENDING for the tenant's hold (WalletSvc). The platform fee stays
 * on ilovelawyer's Stripe balance. Settled once, on payment_intent.succeeded or when the client app
 * asks (status), whichever comes first. The earning's hold starts when the engagement closes
 * (ClientRequestRepo.close), not here. Also: expiring quotations the client didn't accept or pay in
 * time (expireDue), admin refunds (QuotationRefundSvc), and the client's bank disputing a payment,
 * which a Lawyer Exit on it waits for (LawyerExitSvc).
 */
export default class QuotationPaymentSvc {
  /**
   * Starts (or resumes) paying the request's accepted quotation. With Stripe: a PENDING payment and a
   * PaymentIntent for the accepted amount, whose client secret the app hands to the Payment Element;
   * the same intent comes back while it's still open. With the dummy: it settles now (402
   * PAYMENT_DECLINED for the test decline). 409 QUOTATION_EXPIRED after the lawyer's expiry.
   */
  static async start(
    clientId: string,
    requestId: string,
    quotationId: string,
    opts: { testOutcome?: "decline" } = {},
    resumedOnce = false,
  ): Promise<{ payment: ReturnType<typeof paymentDto>; intent: { clientSecret: string; publishableKey: string } | null }> {
    const quotation = await QuotationPaymentSvc.acceptedQuotation(clientId, requestId, quotationId);
    const provider = quotationPaymentProvider();
    const started = await QuotationPaymentRepo.start(quotation.id, { clientId, provider: provider.name });
    if ("refused" in started) throw QuotationPaymentSvc.refusal(started.refused, requestId);
    const { payment, existing } = started;

    if (provider.mode === "immediate") {
      const result = await provider.pay(QuotationPaymentSvc.payRequest(payment, quotation, clientId, null, opts.testOutcome));
      await QuotationPaymentSvc.applyResult(payment, result);
      const after = (await QuotationPaymentRepo.findById(payment.id))!;
      if (result.status === "FAILED") throw new HttpError(result.failureReason ?? "The payment was declined.", 402, "PAYMENT_DECLINED");
      return { payment: paymentDto(after), intent: null };
    }

    // An open intent from before: hand it back, unless it has moved on at Stripe.
    if (existing && payment.provider === "STRIPE" && payment.paymentIntentId) {
      const stripe = quotationPaymentProviderNamed("STRIPE");
      if (stripe.mode === "intent") {
        const resumed = await stripe.resumeIntent(payment.paymentIntentId);
        if (resumed.status === "PENDING") {
          return { payment: paymentDto(payment), intent: { clientSecret: resumed.clientSecret, publishableKey: resumed.publishableKey } };
        }
        await QuotationPaymentSvc.applyResult(payment, resumed);
        // Starts again once: the moved-on attempt is settled or ended now. Still PENDING (settling it
        // was refused, or it's already being settled elsewhere) means come back shortly, not a loop.
        const after = await QuotationPaymentRepo.findById(payment.id);
        if (resumedOnce || after?.status === "PENDING") {
          throw new HttpError("Your payment is still being processed. Try again in a moment.", 409, "PAYMENT_IN_PROGRESS");
        }
        return QuotationPaymentSvc.start(clientId, requestId, quotationId, opts, true);
      }
    }

    try {
      const intent = await provider.createIntent(QuotationPaymentSvc.payRequest(payment, quotation, clientId, await ClientPaymentRepo.findEmail(clientId)));
      await QuotationPaymentRepo.setPaymentIntent(payment.id, intent.paymentIntentId);
      return { payment: paymentDto((await QuotationPaymentRepo.findById(payment.id))!), intent: { clientSecret: intent.clientSecret, publishableKey: intent.publishableKey } };
    } catch (err) {
      logger.error("Quotation payment: intent could not be created", { paymentId: payment.id, err: err instanceof Error ? err.message : String(err) });
      await QuotationPaymentRepo.end(payment.id, "FAILED", UNREACHABLE);
      if (err instanceof HttpError) throw err;
      throw new HttpError(UNREACHABLE, 502, "PAYMENT_PROVIDER_ERROR");
    }
  }

  /** Where the client's payment for this request stands: the newest attempt, checked with Stripe
   * first while PENDING, so the app learns the outcome straight after the client pays. */
  static async status(clientId: string, requestId: string) {
    const request = await ClientRequestRepo.findForClient(requestId, clientId);
    if (!request) throw new HttpError("Request not found", 404);
    const quotation = await QuotationRepo.findAcceptedForRequest(requestId);
    if (!quotation) return { payment: null };
    let payment = await QuotationPaymentRepo.findLatest(quotation.id);
    if (payment?.status === "PENDING" && payment.provider === "STRIPE" && payment.paymentIntentId) {
      const stripe = quotationPaymentProviderNamed("STRIPE");
      if (stripe.mode === "intent") {
        try {
          await QuotationPaymentSvc.applyResult(payment, await stripe.status(payment.paymentIntentId));
          payment = (await QuotationPaymentRepo.findById(payment.id)) ?? payment;
        } catch (err) {
          logger.warn("Quotation payment: Stripe status check failed", { paymentId: payment.id, err: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    return { payment: payment ? paymentDto(payment) : null };
  }

  /** payment_intent.succeeded / payment_intent.payment_failed for one of ours, read fresh from Stripe
   * rather than trusted from the event. */
  static async applyStripeIntent(intent: Stripe.PaymentIntent) {
    const payment = (intent.metadata?.paymentId ? await QuotationPaymentRepo.findById(intent.metadata.paymentId) : null) ?? (await QuotationPaymentRepo.findByPaymentIntent(intent.id));
    if (!payment || payment.provider !== "STRIPE") {
      logger.info("Stripe webhook: no quotation payment of ours", { paymentIntentId: intent.id });
      return;
    }
    const stripe = quotationPaymentProviderNamed("STRIPE");
    if (stripe.mode !== "intent") return;
    await QuotationPaymentSvc.applyResult(payment, await stripe.status(intent.id));
  }

  /** charge.dispute.created / charge.dispute.closed on one of our payments. */
  static async applyStripeDispute(dispute: Stripe.Dispute, opened: boolean) {
    const paymentIntentId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
    const payment = paymentIntentId ? await QuotationPaymentRepo.findByPaymentIntent(paymentIntentId) : null;
    if (!payment) return;
    if (opened) {
      await QuotationPaymentRepo.openDispute(payment.id);
      await LawyerExitSvc.disputeOpened(payment.id);
      return;
    }
    // Only "lost" takes the money back; "won" and an inquiry's "warning_closed" leave it with us.
    const lost = dispute.status === "lost";
    const walletId = await QuotationPaymentRepo.closeDispute(payment.id, lost, dispute.id);
    if (walletId) await WalletSvc.changedById(walletId);
    // A Lawyer Exit waiting on the bank carries on now. Its earning stays held until it settles (an
    // exit's earning has no availableAt), so a won dispute releases nothing early.
    await LawyerExitSvc.disputeClosed(payment.id, lost);
  }

  /** refund.updated / refund.failed for a refund of ours. */
  static async applyStripeRefund(refund: Stripe.Refund) {
    const refundId = refund.metadata?.refundId;
    if (!refundId) return;
    const status = refund.status === "succeeded" ? "SUCCEEDED" : refund.status === "failed" || refund.status === "canceled" ? "FAILED" : null;
    if (!status) return;
    const settled = await QuotationPaymentRepo.settleRefund(refundId, { status, externalId: refund.id, failureReason: status === "FAILED" ? (refund.failure_reason ?? "Stripe couldn't complete the refund") : null });
    if (settled?.walletId) await WalletSvc.changedById(settled.walletId);
    // A Lawyer Exit waiting on this refund: settled, or handed to an admin when it failed.
    await LawyerExitSvc.afterRefund(refundId);
  }

  /**
   * The sweep (ClientRequestSweepQueue): every quotation whose lawyer-set expiry has passed while
   * waiting on the client. SENT: it expires and the lawyer's claim ends. ACCEPTED but unpaid: any open
   * PaymentIntent is cancelled first; if Stripe says it went through after all, the payment is
   * settled and the engagement stands. Otherwise it expires and the request goes back to other lawyers.
   */
  static async expireDue(now: Date = new Date()): Promise<number> {
    let expired = 0;
    for (const q of await QuotationRepo.findExpired(now)) {
      try {
        if (q.status === "SENT") {
          if (await QuotationRepo.expireSent(q, now)) {
            expired++;
            await QuotationPaymentSvc.afterExpiry(q, "ROUTED", now);
          }
          continue;
        }
        if (await QuotationPaymentSvc.cancelOpenPayments(q.id)) continue;
        if (await QuotationRepo.expireAccepted(q, now)) {
          expired++;
          await QuotationPaymentSvc.afterExpiry(q, "ROUTED", now);
        }
      } catch (err) {
        logger.error("Quotation expiry failed", { quotationId: q.id, err });
      }
    }
    return expired;
  }

  /**
   * An admin refund, in full when no amount is given. A full refund gives back the platform fee too; a
   * partial one comes out of the lawyer's service fee only, so it can be at most what's left of that,
   * and the platform fee is kept. The lawyer's earning is reversed by the service-fee part once the
   * refund goes through. Audited. Gives back money only: the engagement carries on. (A Lawyer Exit's
   * refund is decided on the exit instead: LawyerExitSvc.decide.)
   */
  static async refund(paymentId: string, input: { amount?: { amountMinor: number; currency: string }; reason: string }, adminId: string) {
    const payment = await QuotationPaymentRepo.findById(paymentId);
    if (!payment) throw new HttpError("Payment not found", 404);
    if (input.amount && input.amount.currency !== payment.currency) throw new HttpError(`This payment is in ${payment.currency}.`, 400, "REFUND_CURRENCY_MISMATCH");
    const amountMinor = await QuotationRefundSvc.assertRefundable(payment, input.amount?.amountMinor ?? null);
    const issued = await QuotationRefundSvc.issue(payment, amountMinor, input.reason, { adminId });
    if (!issued) throw new HttpError("Another refund changed what's left of this payment. Look again and retry.", 409, "REFUND_EXCEEDS_CHARGE");
    if (issued.status === "FAILED") throw new HttpError(issued.failureReason ?? "The refund failed.", 502, "REFUND_FAILED");
    const row = (await QuotationPaymentRepo.list({ id: paymentId }, 1, 1)).data[0]!;
    return QuotationPaymentSvc.adminDto(row, await LawyerExitRepo.findByRequest(row.requestId));
  }

  /** The admin app's list: payments that took money by default, every attempt with `all`. */
  static async listForAdmin(query: { status?: QuotationPayment["status"]; all?: boolean; page: number; limit: number }) {
    const where = query.status ? { status: query.status } : query.all ? {} : { status: { in: PAID_QUOTATION_PAYMENT_STATUSES } };
    const { total, data } = await QuotationPaymentRepo.list(where, query.page, query.limit);
    const exits = await LawyerExitRepo.findByPayments(data.map((p) => p.id));
    return { total, page: query.page, pageSize: query.limit, data: data.map((p) => QuotationPaymentSvc.adminDto(p, exits.get(p.id) ?? null)) };
  }

  /** The admin app's row. `refundable` and `refundableServiceFee` are what refund() would allow now
   * (the same count as refundedSoFar: pending refunds hold their share back), 0 when it can't be
   * refunded at all; `refundPending` is what's on its way at Stripe. `lawyerExit`: the lawyer stopped
   * acting after this payment, with their reason and notes (admins only), and where it stands. */
  private static adminDto(p: QuotationPayment & { refunds: QuotationRefund[] }, exit: LawyerExit | null) {
    const held = p.refunds.filter((r) => r.status === "PENDING" || r.status === "SUCCEEDED");
    const pending = p.refunds.filter((r) => r.status === "PENDING").reduce((sum, r) => sum + r.amountMinor, 0);
    const refundableStatus = PAID_QUOTATION_PAYMENT_STATUSES.includes(p.status) && p.status !== "REFUNDED" && p.status !== "DISPUTED";
    const left = refundableStatus ? Math.max(0, p.amountMinor - held.reduce((sum, r) => sum + r.amountMinor, 0)) : 0;
    const serviceLeft = refundableStatus ? Math.max(0, p.serviceFeeMinor - held.reduce((sum, r) => sum + r.serviceFeeMinor, 0)) : 0;
    return {
      ...paymentDto(p),
      requestId: p.requestId,
      clientId: p.clientId,
      paymentIntentId: p.paymentIntentId,
      refundPending: money(pending, p.currency),
      refundable: money(left, p.currency),
      refundableServiceFee: money(Math.min(serviceLeft, left), p.currency),
      refunds: p.refunds.map((r) => refundDto(r, p.currency)),
      lawyerExit:
        exit && exit.paymentId === p.id
          ? {
              id: exit.id,
              status: exit.status,
              reason: exit.reason,
              note: exit.note,
              workDone: exit.workDone,
              claimed: exit.claimedMinor === null ? null : money(exit.claimedMinor, exit.currency),
              claimNote: exit.claimNote,
              refunded: money(exit.refundedMinor, exit.currency),
              failureReason: exit.failureReason,
              createdAt: exit.createdAt,
              settledAt: exit.settledAt,
            }
          : null,
    };
  }

  /** Records a provider's answer on one attempt, and what follows from a success. */
  private static async applyResult(payment: QuotationPayment, result: QuotationPaymentResult) {
    if (result.status === "PENDING") return;
    if (result.status === "FAILED" || result.status === "CANCELED") {
      await QuotationPaymentRepo.end(payment.id, result.status, result.failureReason);
      return;
    }
    await QuotationPaymentSvc.settle(payment, result.paymentIntentId);
  }

  /** Money taken: engage the request and pay the lawyer's wallet, or, if the request moved on just
   * before (the quote expired), give the money straight back. */
  private static async settle(payment: QuotationPayment, paymentIntentId: string | null) {
    const quotation = await QuotationRepo.findById(payment.quotationId);
    const claim = quotation ? await prisma.clientRequestClaim.findUnique({ where: { id: quotation.claimId }, select: { organizationId: true, lawyerId: true } }) : null;
    if (!quotation || !claim) {
      logger.error("Quotation payment: settled payment has no quotation", { paymentId: payment.id });
      return;
    }
    const wallet = await WalletRepo.findOrCreate(payeeOf(claim), payment.currency);
    const now = new Date();
    // The earning waits PENDING with no date: its hold starts when the engagement closes.
    const settled = await QuotationPaymentRepo.settle(payment.id, { walletId: wallet.id, lawyerId: claim.lawyerId }, paymentIntentId, now);
    if (!settled.settled) return;

    if (settled.orphaned) {
      logger.warn("Quotation payment: money taken after the request moved on, refunding", { paymentId: payment.id, requestId: payment.requestId });
      // Refused: FAILED. No answer: left PENDING for refund.updated, since Stripe may have made it.
      await QuotationRefundSvc.issue(settled.payment, payment.amountMinor, "Paid after the quote expired", "SYSTEM").catch((err) =>
        logger.error("Quotation payment: refund of a late payment failed", { paymentId: payment.id, err: err instanceof Error ? err.message : String(err) }),
      );
      await notify(payment.clientId, {
        title: "Your payment is being refunded",
        message: "The quote had expired by the time your payment went through, so we're giving the money back.",
        link: `/cases`,
      });
      return;
    }
    await QuotationPaymentSvc.afterEngaged(quotation, claim, settled.earning?.netMinor ?? 0, wallet.id);
  }

  /** The request is ENGAGED: the lawyer gets read-only access to the case, both sides are told. */
  static async afterEngaged(quotation: Quotation, claim: { organizationId: string | null; lawyerId: string }, earnedMinor: number, walletId: string | null) {
    const request = await ClientRequestRepo.findForLawyer(quotation.requestId);
    if (!request) return;
    const now = new Date().toISOString();
    await OrganizationRepo.writeAudit({ caseId: request.caseId, action: "client_request.engaged", payload: { requestId: request.id, quotationId: quotation.id } });
    await EngagementAccessSvc.grant({ requestId: request.id, caseId: request.caseId, lawyerId: claim.lawyerId, organizationId: claim.organizationId });
    const updated: ClientRequestUpdatedEvent = { requestId: request.id, status: "ENGAGED", updatedAt: now };
    emitToUser(request.clientId, "client-request:updated", updated);
    emitToUser(claim.lawyerId, "client-request:updated", updated);
    await notify(claim.lawyerId, {
      title: "You're engaged on a client request",
      message:
        earnedMinor > 0
          ? `The client paid your quote. ${gbp(earnedMinor)} is in your earnings, held until you close the engagement and for the usual hold after that.`
          : "The client accepted your quote.",
      link: `/client-requests/${request.id}`,
    });
    if (walletId) await WalletSvc.changedById(walletId);
  }

  /** Cancels a quotation's open PaymentIntents before it expires. True when one had gone through
   * after all (it's settled here, and the quotation must not expire). */
  private static async cancelOpenPayments(quotationId: string): Promise<boolean> {
    for (const payment of await QuotationPaymentRepo.findPending(quotationId)) {
      const provider = quotationPaymentProviderNamed(payment.provider);
      if (provider.mode !== "intent" || !payment.paymentIntentId) continue;
      const result = await provider.cancel(payment.paymentIntentId);
      if (result.status === "SUCCEEDED") {
        await QuotationPaymentSvc.settle(payment, result.paymentIntentId);
        return true;
      }
      // Still processing at the bank: leave it, and the quotation, for the next run.
      if (result.status === "PENDING") return true;
      await QuotationPaymentRepo.end(payment.id, "CANCELED", "The quote expired before it was paid.");
    }
    return false;
  }

  private static async afterExpiry(q: Awaited<ReturnType<typeof QuotationRepo.findExpired>>[number], status: "ROUTED", now: Date) {
    const updated: ClientRequestUpdatedEvent = { requestId: q.requestId, status, updatedAt: now.toISOString() };
    emitToUser(q.lawyerId, "client-request:updated", updated);
    emitToUser(q.request.clientId, "client-request:updated", updated);
    await OrganizationRepo.writeAudit({ caseId: q.request.caseId, action: "client_request.quotation_expired", payload: { requestId: q.requestId, quotationId: q.id, lawyerId: q.lawyerId } });
    await notify(q.lawyerId, {
      title: "Your quote expired",
      message: q.status === "ACCEPTED" ? "The client accepted your quote but didn't pay before it expired, so the request went back to other lawyers." : "The client didn't accept your quote before it expired.",
      link: "/client-requests?view=history",
    });
  }

  private static payRequest(payment: QuotationPayment, quotation: Quotation, clientId: string, customerEmail: string | null, testOutcome?: "decline") {
    return {
      paymentId: payment.id,
      quotationId: quotation.id,
      requestId: quotation.requestId,
      clientId,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      description: "Lawyer's fee and ilovelawyer platform fee",
      customerEmail,
      testOutcome,
    };
  }

  /** The request's accepted quotation, the client's own, or 404/409. */
  private static async acceptedQuotation(clientId: string, requestId: string, quotationId: string) {
    const request = await ClientRequestRepo.findForClient(requestId, clientId);
    if (!request) throw new HttpError("Request not found", 404);
    const quotation = await QuotationRepo.findById(quotationId);
    if (!quotation || quotation.requestId !== requestId) throw new HttpError("Quote not found", 404);
    if (quotation.status === "PAID") throw new HttpError("This quote is already paid.", 409, "INVALID_REQUEST_STATUS", { status: request.status });
    if (quotation.status !== "ACCEPTED") throw new HttpError("Accept the quote before paying it.", 409, "INVALID_REQUEST_STATUS", { status: request.status });
    // Accepted before quotation payments: the client pays this lawyer outside ilovelawyer.
    if (quotation.acceptedAmountMinor === null) throw new HttpError("This quote isn't paid through ilovelawyer.", 409, "INVALID_REQUEST_STATUS", { status: request.status });
    if (quotation.expiresAt <= new Date()) throw new HttpError("This quote has expired.", 409, "QUOTATION_EXPIRED");
    return quotation;
  }

  private static refusal(refused: "CLOSED" | "EXPIRED" | "PAID", requestId: string) {
    if (refused === "EXPIRED") return new HttpError("This quote has expired.", 409, "QUOTATION_EXPIRED");
    if (refused === "PAID") return new HttpError("This quote is already paid.", 409, "INVALID_REQUEST_STATUS", { requestId });
    return new HttpError("This quote can't be paid now.", 409, "INVALID_REQUEST_STATUS", { requestId });
  }
}
