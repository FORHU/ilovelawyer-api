import type Stripe from "stripe";
import ClientRequestAdminRepo, { AdminRequestFilter, AdminRequestRow, ChargeWithRefunds, PAID_CHARGE_STATUSES } from "../repositories/client-request-admin.repository";
import ClientRequestMatchingSvc from "./client-request-matching.service";
import SecurityAuditSvc from "./security-audit.service";
import { chargeDto } from "./organization-charge.service";
import { organizationCardProviderNamed } from "../payments/organization-card-provider";
import { refundResultOf } from "../payments/client-refunds";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

const HOUR_MS = 60 * 60 * 1000;
const money = (amountMinor: number, currency = "GBP") => ({ amountMinor, currency });

/** Why a charge can't be refunded, or null when it can. A test card's charge took no money. */
function refusal(charge: ChargeWithRefunds): { message: string; code: string; status: number } | null {
  if (charge.provider !== "STRIPE" || !charge.paymentIntentId) {
    return { message: "This charge was made to a test card: no money was taken, so there's nothing to refund.", code: "REFUND_NOT_SUPPORTED", status: 409 };
  }
  if (!PAID_CHARGE_STATUSES.includes(charge.status)) {
    return { message: `Only a charge that went through can be refunded; this one is ${charge.status}.`, code: "CHARGE_NOT_REFUNDABLE", status: 409 };
  }
  return null;
}

/** A refund as the admin app shows it, with who issued it. */
function refundDto(r: ChargeWithRefunds["refunds"][number], admins: Map<string, string>) {
  return {
    id: r.id,
    amount: money(r.amountMinor, r.currency),
    reason: r.reason,
    status: r.status,
    externalId: r.externalId,
    failureReason: r.failureReason,
    admin: r.adminId ? { id: r.adminId, name: admins.get(r.adminId) ?? null } : null,
    createdAt: r.createdAt,
  };
}

/**
 * Platform admins' view of the UK client-to-lawyer hand-off (ilovelawyer-admin, #520): every request
 * with its claims and charges, the fees per firm or lawyer, and refunds of the firms' charges (the
 * per-case fee, #513; AI top-ups, #516). Refunds go through Stripe and are audited
 * (admin.organization_charge.refunded) in the firm's own log too. A refund gives back money only: the
 * engagement it paid for carries on.
 */
export default class ClientRequestAdminSvc {
  static async listRequests(filter: AdminRequestFilter, page: number, limit: number) {
    const now = new Date();
    const { total, data } = await ClientRequestAdminRepo.listRequests(filter, page, limit, now);
    const lawyerIds = [...new Set(data.flatMap((r) => r.charges.map((c) => c.lawyerId)).filter((id): id is string => !!id))];
    const adminIds = [...new Set(data.flatMap((r) => r.charges.flatMap((c) => c.refunds.map((f) => f.adminId))).filter((id): id is string => !!id))];
    const users = await ClientRequestAdminRepo.findUserNames([...new Set([...lawyerIds, ...adminIds])]);
    const names = new Map(users.map((u) => [u.id, u.name || u.email] as const));
    const matched = await Promise.all(data.map((r) => (r.status === "ROUTED" ? ClientRequestMatchingSvc.eligibleLawyerIds(r.id).then((ids) => ids.length) : 0)));
    return {
      total,
      page,
      pageSize: limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      data: data.map((r, i) => ClientRequestAdminSvc.requestDto(r, matched[i]!, names, now)),
    };
  }

  /** Fees per organization or lawyer over a date range (to exclusive). */
  static async feesSummary(groupBy: "organization" | "lawyer", from?: Date, to?: Date) {
    const rows = await ClientRequestAdminRepo.feesSummary(groupBy, from, to);
    const ids = rows.map((r) => r.key);
    const names =
      groupBy === "organization"
        ? new Map((await ClientRequestAdminRepo.findOrganizationNames(ids)).map((o) => [o.id, o.name] as const))
        : new Map((await ClientRequestAdminRepo.findUserNames(ids)).map((u) => [u.id, u.name || u.email] as const));
    return rows.map((r) => ({
      id: r.key,
      name: names.get(r.key) ?? (groupBy === "organization" ? "Deleted organization" : "Deleted account"),
      engagements: r.engagements,
      perCaseFees: money(r.perCaseFees),
      topUps: money(r.topUps),
      refunds: money(r.refunds),
    }));
  }

  /**
   * Refunds a firm's charge through Stripe, in full when no amount is given. The refund is recorded
   * (and its amount held against the charge) before Stripe is called, then updated with Stripe's
   * answer; one Stripe hasn't finished stays PENDING until refund.updated. Audited either way.
   */
  static async refundCharge(chargeId: string, input: { amount?: { amountMinor: number; currency: string }; reason: string }, adminId: string) {
    const charge = await ClientRequestAdminRepo.findCharge(chargeId);
    if (!charge) throw new HttpError("Charge not found", 404);
    const refused = refusal(charge);
    if (refused) throw new HttpError(refused.message, refused.status, refused.code);
    if (input.amount && input.amount.currency !== charge.currency) {
      throw new HttpError(`This charge is in ${charge.currency}.`, 400, "REFUND_CURRENCY_MISMATCH");
    }

    const refund = await ClientRequestAdminRepo.startRefund({ chargeId, amountMinor: input.amount?.amountMinor ?? null, reason: input.reason, adminId });
    const audit = {
      action: "admin.organization_charge.refunded" as const,
      actorId: adminId,
      organizationId: charge.organizationId,
      targetType: "organization" as const,
      targetId: charge.organizationId,
      payload: { chargeId, kind: charge.kind, requestId: charge.requestId, refundId: refund.id, amountMinor: refund.amountMinor, currency: refund.currency, reason: input.reason },
    };

    const stripe = organizationCardProviderNamed("STRIPE");
    let result;
    try {
      if (stripe.mode !== "hosted") throw new Error("Stripe isn't available");
      result = await stripe.refund({ refundId: refund.id, chargeId, paymentIntentId: charge.paymentIntentId!, amountMinor: refund.amountMinor });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error("Organization charge refund failed", { chargeId, refundId: refund.id, err: reason });
      await ClientRequestAdminRepo.updateRefund(refund.id, { status: "FAILED", failureReason: reason });
      const error = new HttpError(`Stripe couldn't take the refund: ${reason}`, 502, "PAYMENT_PROVIDER_ERROR");
      await SecurityAuditSvc.recordFailure(audit, error);
      throw error;
    }

    await ClientRequestAdminRepo.updateRefund(refund.id, result);
    await SecurityAuditSvc.record({
      ...audit,
      outcome: result.status === "FAILED" ? "FAILURE" : "SUCCESS",
      payload: { ...audit.payload, status: result.status, stripeRefundId: result.externalId },
    });
    return ClientRequestAdminSvc.getCharge(chargeId);
  }

  /** One charge with its refunds, for the admin app. */
  static async getCharge(chargeId: string) {
    const charge = await ClientRequestAdminRepo.findCharge(chargeId);
    if (!charge) throw new HttpError("Charge not found", 404);
    const ids = [charge.lawyerId, ...charge.refunds.map((r) => r.adminId)].filter((id): id is string => !!id);
    const names = new Map((await ClientRequestAdminRepo.findUserNames([...new Set(ids)])).map((u) => [u.id, u.name || u.email] as const));
    return ClientRequestAdminSvc.adminChargeDto(charge, names);
  }

  /** Stripe's refund.updated / refund.failed for a refund of a firm's charge. One this server didn't
   * issue is ignored. */
  static async applyStripeRefund(refund: Stripe.Refund) {
    const ours = await ClientRequestAdminRepo.findRefund(refund.metadata?.refundId, refund.id);
    if (!ours) {
      logger.info("Stripe webhook: no organization charge refund of ours", { stripeRefundId: refund.id });
      return;
    }
    const result = refundResultOf(refund);
    if (result.status === ours.status && ours.externalId === result.externalId) return;
    await ClientRequestAdminRepo.updateRefund(ours.id, result);
  }

  private static adminChargeDto(c: ChargeWithRefunds, names: Map<string, string>) {
    const held = c.refunds.filter((r) => r.status !== "FAILED").reduce((sum, r) => sum + r.amountMinor, 0);
    return {
      ...chargeDto(c, c.lawyerId ? (names.get(c.lawyerId) ?? null) : null),
      organizationId: c.organizationId,
      paymentIntentId: c.paymentIntentId,
      refundPending: money(c.refunds.filter((r) => r.status === "PENDING").reduce((sum, r) => sum + r.amountMinor, 0), c.currency),
      /** What a refund can still give back; 0 when the charge can't be refunded. */
      refundable: money(refusal(c) ? 0 : Math.max(0, c.amountMinor - held), c.currency),
      refunds: c.refunds.map((r) => refundDto(r, names)),
    };
  }

  private static requestDto(r: AdminRequestRow, matchedLawyers: number, names: Map<string, string>, now: Date) {
    const latest = r.claims[0];
    return {
      id: r.id,
      caseId: r.caseId,
      clientId: r.clientId,
      status: r.status,
      createdAt: r.createdAt,
      ageHours: Math.round(((now.getTime() - r.createdAt.getTime()) / HOUR_MS) * 10) / 10,
      unclaimedOver48h: r.status === "ROUTED" && !!r.routingExpiresAt && r.routingExpiresAt <= now,
      routedAt: r.routedAt,
      routingExpiresAt: r.routingExpiresAt,
      engagedAt: r.engagedAt,
      practiceArea: r.case.practiceArea,
      ukJurisdiction: r.case.ukJurisdiction,
      matchedLawyers,
      claims: r.claims.map((c) => ({
        lawyerId: c.lawyerId,
        lawyerName: c.lawyer.name || c.lawyer.email,
        organizationId: c.organizationId,
        organizationName: c.organization.name,
        claimedAt: c.claimedAt,
        endedAt: c.endedAt,
        outcome: c.outcome,
        releaseReason: c.releaseReason,
        quote: c.quotedAt ? { type: c.quoteType, amount: money(c.quoteAmountMinor ?? 0, c.quoteCurrency ?? "GBP"), sentAt: c.quotedAt } : null,
      })),
      organizationName: latest?.organization.name ?? null,
      charges: r.charges.map((c) => ClientRequestAdminSvc.adminChargeDto(c, names)),
    };
  }
}
