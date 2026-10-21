import type Stripe from "stripe";
import ClientBillingAdminRepo, { AdminClientPaymentRow, ClientBillingFilter, MoneyGroup } from "../repositories/client-billing-admin.repository";
import { clientRefunder, refundResultOf } from "../payments/client-refunds";
import SecurityAuditSvc from "./security-audit.service";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

const money = (amountMinor: number, currency: string) => ({ amountMinor, currency });

/** Why a payment can't be refunded, or null when it can. A DUMMY payment took no money, and a FREE
 * one (a promo brought it to zero) took none either, so there is nothing to give back. */
function refusal(payment: AdminClientPaymentRow, left: number): { message: string; code: string } | null {
  if (payment.provider === "DUMMY") {
    return { message: "This payment went through the dummy provider: no money was taken, so there's nothing to refund.", code: "REFUND_NOT_SUPPORTED" };
  }
  if (payment.provider === "FREE") return { message: "This payment came to nothing after a promo code, so there's nothing to refund.", code: "REFUND_NOT_SUPPORTED" };
  if (payment.provider !== "STRIPE" || !payment.externalId) return { message: `A ${payment.provider} payment can't be refunded from here.`, code: "REFUND_NOT_SUPPORTED" };
  if (payment.status !== "SUCCEEDED") return { message: `Only a payment that went through can be refunded; this one is ${payment.status}.`, code: "PAYMENT_NOT_REFUNDABLE" };
  if (left <= 0) return { message: "This payment has already been refunded in full", code: "ALREADY_REFUNDED" };
  return null;
}

function sumRefunds(payment: AdminClientPaymentRow, status: "PENDING" | "SUCCEEDED") {
  return payment.refunds.filter((r) => r.status === status).reduce((sum, r) => sum + r.amountMinor, 0);
}

/**
 * The admin app's view of client app payments (ilovelawyer-admin's Billing page, #538): the case fees
 * and chat credit top-ups clients pay, not the lawyer's per-case fee (ilovelawyer-api#520). Read
 * endpoints mirror the admin LLM usage ones. Refunds go through Stripe, by the payment's stored
 * provider, and are audited (admin.client_payment.refunded). A refund gives back money only: the
 * case and its credits stay, so an admin who wants them gone does that separately.
 */
export default class ClientBillingAdminSvc {
  static async list(filter: ClientBillingFilter, page: number, pageSize: number) {
    const [rows, total] = await Promise.all([ClientBillingAdminRepo.list(filter, pageSize, (page - 1) * pageSize), ClientBillingAdminRepo.count(filter)]);
    return { rows: await ClientBillingAdminSvc.toDtos(rows), total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  static async get(paymentId: string) {
    const payment = await ClientBillingAdminRepo.findById(paymentId);
    if (!payment) throw new HttpError("Payment not found", 404);
    return (await ClientBillingAdminSvc.toDtos([payment]))[0];
  }

  /**
   * Revenue over the filter: what SUCCEEDED payments brought in, per currency, less the refunds of
   * those payments, with the splits by kind, provider and day. DUMMY payments are included unless the
   * filter names a provider: they are fake money, and byProvider shows how much of it there is.
   */
  static async summary(filter: ClientBillingFilter) {
    const [total, byKind, byProvider, byDay, counts, refunds] = await Promise.all([
      ClientBillingAdminRepo.paidBy(filter, null),
      ClientBillingAdminRepo.paidBy(filter, "kind"),
      ClientBillingAdminRepo.paidBy(filter, "provider"),
      ClientBillingAdminRepo.paidByDay(filter),
      ClientBillingAdminRepo.countByStatus(filter),
      ClientBillingAdminRepo.refundsOf(filter),
    ]);
    const currencies = [...new Set([...total.map((t) => t.currency), ...refunds.map((r) => r.currency)])].sort();
    const refunded = (currency: string, status: "PENDING" | "SUCCEEDED") =>
      refunds.filter((r) => r.currency === currency && r.status === status).reduce((sum, r) => sum + r.amountMinor, 0);
    const group = (g: MoneyGroup) => ({ key: g.key, amount: money(g.amountMinor, g.currency), payments: g.payments });
    return {
      totals: currencies.map((currency) => {
        const paid = total.find((t) => t.currency === currency);
        const refundedMinor = refunded(currency, "SUCCEEDED");
        return {
          currency,
          paid: money(paid?.amountMinor ?? 0, currency),
          payments: paid?.payments ?? 0,
          refunded: money(refundedMinor, currency),
          refundPending: money(refunded(currency, "PENDING"), currency),
          net: money((paid?.amountMinor ?? 0) - refundedMinor, currency),
        };
      }),
      counts: { PENDING: counts.PENDING ?? 0, SUCCEEDED: counts.SUCCEEDED ?? 0, FAILED: counts.FAILED ?? 0 },
      byKind: byKind.map(group),
      byProvider: byProvider.map(group),
      byDay: byDay.map((d) => ({ day: d.day.toISOString().slice(0, 10), amount: money(d.amountMinor, d.currency), payments: d.payments })),
    };
  }

  /** One client: who they are, their totals, their cases' credits, and a page of their payments. */
  static async client(userId: string, page: number, pageSize: number) {
    const user = await ClientBillingAdminRepo.findClient(userId);
    if (!user) throw new HttpError("User not found", 404);
    const filter = { userId };
    const [summary, cases, payments] = await Promise.all([
      ClientBillingAdminSvc.summary(filter),
      ClientBillingAdminRepo.clientCases(userId),
      ClientBillingAdminSvc.list(filter, page, pageSize),
    ]);
    return {
      user,
      totals: summary.totals,
      counts: summary.counts,
      cases: cases.map((c) => ({ id: c.id, title: c.caseName, credits: c.clientCredits, createdAt: c.createdAt })),
      payments,
    };
  }

  /**
   * Refunds a Stripe payment, in full when no amount is given. The refund is recorded (and its amount
   * held against the payment) before Stripe is called, then updated with Stripe's answer; a refund
   * Stripe hasn't finished stays PENDING until its webhook. Audited either way.
   */
  static async refund(paymentId: string, input: { amountMinor?: number; reason: string }, adminId: string) {
    const payment = await ClientBillingAdminRepo.findById(paymentId);
    if (!payment) throw new HttpError("Payment not found", 404);
    const left = payment.amountMinor - sumRefunds(payment, "PENDING") - sumRefunds(payment, "SUCCEEDED");
    const refused = refusal(payment, left);
    if (refused) throw new HttpError(refused.message, 409, refused.code);

    const refund = await ClientBillingAdminRepo.startRefund({ paymentId, amountMinor: input.amountMinor ?? null, reason: input.reason, adminId });
    const audit = {
      action: "admin.client_payment.refunded" as const,
      actorId: adminId,
      targetType: "user" as const,
      targetId: payment.userId,
      caseId: payment.caseId,
      payload: { paymentId, refundId: refund.id, amountMinor: refund.amountMinor, currency: refund.currency, reason: input.reason },
    };

    let result;
    try {
      result = await clientRefunder()({ refundId: refund.id, paymentId, checkoutSessionId: payment.externalId!, amountMinor: refund.amountMinor });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error("Stripe refund failed", { paymentId, refundId: refund.id, err: reason });
      await ClientBillingAdminRepo.updateRefund(refund.id, { status: "FAILED", failureReason: reason });
      const error = new HttpError(`Stripe couldn't take the refund: ${reason}`, 502, "PAYMENT_PROVIDER_ERROR");
      await SecurityAuditSvc.recordFailure(audit, error);
      throw error;
    }

    await ClientBillingAdminRepo.updateRefund(refund.id, result);
    await SecurityAuditSvc.record({
      ...audit,
      outcome: result.status === "FAILED" ? "FAILURE" : "SUCCESS",
      payload: { ...audit.payload, status: result.status, stripeRefundId: result.externalId },
    });
    return ClientBillingAdminSvc.get(paymentId);
  }

  /** Stripe's refund.updated / refund.failed: brings a refund we issued to Stripe's status. A refund
   * this server didn't issue (made in Stripe's dashboard, or another environment) is ignored. */
  static async applyStripeRefund(refund: Stripe.Refund) {
    const ours = await ClientBillingAdminRepo.findRefund(refund.metadata?.refundId, refund.id);
    if (!ours) {
      logger.info("Stripe webhook: no refund of ours", { stripeRefundId: refund.id });
      return;
    }
    const result = refundResultOf(refund);
    if (result.status === ours.status && ours.externalId === result.externalId) return;
    await ClientBillingAdminRepo.updateRefund(ours.id, result);
  }

  private static async toDtos(rows: AdminClientPaymentRow[]) {
    const adminIds = [...new Set(rows.flatMap((r) => r.refunds.map((f) => f.adminId)).filter((id): id is string => !!id))];
    const admins = new Map((await ClientBillingAdminRepo.findUserNames(adminIds)).map((u) => [u.id, u.name || u.email] as const));
    return rows.map((p) => {
      const refunded = sumRefunds(p, "SUCCEEDED");
      const pending = sumRefunds(p, "PENDING");
      const left = p.amountMinor - refunded - pending;
      return {
        id: p.id,
        kind: p.kind,
        status: p.status,
        provider: p.provider,
        externalId: p.externalId,
        amount: money(p.amountMinor, p.currency),
        credits: p.credits,
        promoCode: p.promoCode,
        failureReason: p.failureReason,
        usedAt: p.usedAt,
        createdAt: p.createdAt,
        client: p.user,
        case: p.case ? { id: p.case.id, title: p.case.caseName } : null,
        refunded: money(refunded, p.currency),
        refundPending: money(pending, p.currency),
        refundable: money(refusal(p, left) ? 0 : left, p.currency),
        refunds: p.refunds.map((r) => ({
          id: r.id,
          amount: money(r.amountMinor, r.currency),
          reason: r.reason,
          status: r.status,
          externalId: r.externalId,
          failureReason: r.failureReason,
          admin: r.adminId ? { id: r.adminId, name: admins.get(r.adminId) ?? null } : null,
          createdAt: r.createdAt,
        })),
      };
    });
  }
}
