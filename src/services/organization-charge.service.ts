import type { OrganizationCharge, OrganizationChargeKind, OrganizationChargeRefund } from "@prisma/client";
import type Stripe from "stripe";
import OrganizationChargeRepo from "../repositories/organization-charge.repository";
import OrganizationBillingRepo from "../repositories/organization-billing.repository";
import OrganizationRepo from "../repositories/organization.repository";
import ClientRequestRepo from "../repositories/client-request.repository";
import { organizationCardProviderNamed, type CardChargeResult } from "../payments/organization-card-provider";
import EngagementAccessSvc from "./engagement-access.service";
import NotificationSvc from "./notification.service";
import { emitToUser } from "../lib/socket";
import logger from "../utils/logger";
import { CLIENT_REQUEST_PER_CASE_FEE_MINOR } from "../constants/client-request.constants";
import type { ClientRequestUpdatedEvent } from "../types/client-handoff";

const NO_CARD = "There's no card on file. An owner or admin can add one in the organization's billing settings.";
const UNREACHABLE = "We couldn't reach the payment provider. Try again in a moment.";

export type ChargeOutcome = "SUCCEEDED" | "PENDING" | "FAILED";

/** Charge in the contract: one of a firm's charges, with what's been refunded of it (#520). Shared by
 * the firm's fee history and the admin app. */
export function chargeDto(c: OrganizationCharge & { refunds: OrganizationChargeRefund[] }, lawyerName: string | null) {
  const refunded = c.refunds.filter((r) => r.status === "SUCCEEDED").reduce((sum, r) => sum + r.amountMinor, 0);
  return {
    id: c.id,
    kind: c.kind,
    status: c.status,
    amount: { amountMinor: c.amountMinor, currency: c.currency },
    refunded: { amountMinor: refunded, currency: c.currency },
    requestId: c.requestId,
    lawyer: c.lawyerId ? { id: c.lawyerId, name: lawyerName ?? "" } : null,
    failureReason: c.failureReason,
    /** Stripe's receipt for a paid charge; null for a test card or before it's paid. */
    receiptUrl: c.receiptUrl,
    provider: c.provider,
    createdAt: c.createdAt,
  };
}

/**
 * Charges to a law firm's card on file (OrganizationCharge). The per-case fee (#513) is charged when
 * a client confirms the firm's lawyer: once it goes through, the request is ENGAGED. A declined card
 * leaves the request CONFIRMED, and the lawyer retries once the card is updated. Each attempt goes
 * through the provider the card was saved with (organizationCardProviderNamed), so a test card is
 * never charged for real. AI top-ups (#516) will charge the same way.
 */
export default class OrganizationChargeSvc {
  /** What confirming a lawyer charges their organization. A placeholder until the price is signed off
   * (FORHU/ilovelawyer-app#846). */
  static perCaseFee() {
    return { amountMinor: CLIENT_REQUEST_PER_CASE_FEE_MINOR, currency: "GBP" };
  }

  /**
   * One attempt at a charge, then whatever follows from it (engaging the request, or telling the firm
   * the card was declined). Returns how it ended; null when another attempt is already running or it
   * had already gone through.
   */
  static async attempt(chargeId: string): Promise<ChargeOutcome | null> {
    const charge = await OrganizationChargeRepo.findById(chargeId);
    if (!charge) return null;
    const billing = await OrganizationBillingRepo.find(charge.organizationId);
    if (!billing?.paymentMethodId) {
      await OrganizationChargeRepo.failWithoutAttempt(chargeId, NO_CARD);
      await OrganizationChargeSvc.after({ ...charge, failureReason: NO_CARD }, "FAILED", false);
      return "FAILED";
    }

    const provider = organizationCardProviderNamed(billing.provider);
    const attempt = await OrganizationChargeRepo.startAttempt(chargeId, provider.name);
    if (attempt === null) return null;

    let result: CardChargeResult;
    try {
      result = await provider.charge({
        chargeId,
        attempt,
        customerId: billing.customerId,
        paymentMethodId: billing.paymentMethodId,
        amountMinor: charge.amountMinor,
        currency: charge.currency,
        description: charge.kind === "PER_CASE_FEE" ? "ilovelawyer introduction fee for a client request" : "ilovelawyer AI top-up",
        metadata: { organizationId: charge.organizationId, ...(charge.requestId ? { requestId: charge.requestId } : {}) },
      });
    } catch (err) {
      logger.error("Organization charge: provider unreachable", { chargeId, attempt, err: err instanceof Error ? err.message : String(err) });
      await OrganizationChargeRepo.abandonAttempt(chargeId, attempt, UNREACHABLE);
      await OrganizationChargeSvc.after({ ...charge, failureReason: UNREACHABLE }, "FAILED", false);
      return "FAILED";
    }

    if (result.status === "PENDING") {
      await OrganizationChargeRepo.setPaymentIntent(chargeId, attempt, result.paymentIntentId);
      return "PENDING";
    }
    const { settled, engaged } = await OrganizationChargeRepo.settle(chargeId, { attempts: attempt, status: "PENDING" }, result);
    if (settled) await OrganizationChargeSvc.after({ ...charge, failureReason: result.failureReason }, result.status, engaged);
    return result.status;
  }

  /**
   * Stripe's payment_intent.succeeded / payment_intent.payment_failed for one of our charges (a bank
   * that settled later, or a payment whose direct answer never arrived). The payment is read fresh
   * from Stripe rather than trusted from the event.
   */
  static async applyStripeIntent(intent: Stripe.PaymentIntent) {
    const chargeId = intent.metadata?.chargeId;
    const charge = (chargeId ? await OrganizationChargeRepo.findById(chargeId) : null) ?? (await OrganizationChargeRepo.findByPaymentIntent(intent.id));
    if (!charge || charge.provider !== "STRIPE") {
      logger.info("Stripe webhook: no organization charge of ours", { paymentIntentId: intent.id });
      return;
    }
    const result = await OrganizationChargeSvc.readStripe(intent.id);
    if (!result || result.status === "PENDING") return;
    // A success is recorded whatever we'd marked; a failure only ends the attempt that made this payment.
    const when = result.status === "SUCCEEDED" ? { status: { in: ["PENDING" as const, "FAILED" as const] } } : { status: "PENDING" as const, paymentIntentId: intent.id };
    const { settled, engaged } = await OrganizationChargeRepo.settle(charge.id, when, result);
    if (settled) await OrganizationChargeSvc.after({ ...charge, failureReason: result.failureReason }, result.status, engaged);
  }

  /** The organization's fee history (Charge in the contract), newest first. */
  static async listForOrganization(organizationId: string, query: { kind?: OrganizationChargeKind; page: number; limit: number }) {
    const { total, data } = await OrganizationChargeRepo.listForOrganization(organizationId, query.kind, query.page, query.limit);
    const lawyerIds = [...new Set(data.map((c) => c.lawyerId).filter((id): id is string => !!id))];
    const names = new Map((await OrganizationChargeRepo.findUserNames(lawyerIds)).map((u) => [u.id, u.name || u.email] as const));
    return { total, data: data.map((c) => chargeDto(c, c.lawyerId ? (names.get(c.lawyerId) ?? null) : null)) };
  }

  private static async readStripe(paymentIntentId: string): Promise<CardChargeResult | null> {
    const stripe = organizationCardProviderNamed("STRIPE");
    if (stripe.mode !== "hosted") return null;
    return stripe.chargeStatus(paymentIntentId);
  }

  /** What follows a settled charge. For a per-case fee: engaged, both sides are told; declined, the
   * lawyer and the organization's owners and admins are told to update the card. */
  private static async after(charge: Pick<OrganizationCharge, "id" | "kind" | "requestId" | "organizationId" | "lawyerId" | "failureReason">, outcome: ChargeOutcome, engaged: boolean) {
    if (charge.kind !== "PER_CASE_FEE" || !charge.requestId || outcome === "PENDING") return;
    const request = await ClientRequestRepo.findForLawyer(charge.requestId);
    if (!request) return;
    const now = new Date().toISOString();

    if (outcome === "SUCCEEDED") {
      if (!engaged) return;
      await OrganizationRepo.writeAudit({ caseId: request.caseId, action: "client_request.engaged", payload: { requestId: request.id, chargeId: charge.id } });
      const updated: ClientRequestUpdatedEvent = { requestId: request.id, status: "ENGAGED", updatedAt: now };
      emitToUser(request.clientId, "client-request:updated", updated);
      if (charge.lawyerId) {
        await EngagementAccessSvc.grant({ requestId: request.id, caseId: request.caseId, lawyerId: charge.lawyerId, organizationId: charge.organizationId });
        emitToUser(charge.lawyerId, "client-request:updated", updated);
        await OrganizationChargeSvc.notify(charge.lawyerId, {
          title: "You're engaged on a client request",
          message: "The client confirmed you and the introduction fee went through.",
          link: `/client-requests/${request.id}`,
        });
      }
      return;
    }

    await OrganizationRepo.writeAudit({ caseId: request.caseId, action: "client_request.charge_failed", payload: { requestId: request.id, chargeId: charge.id } });
    const updated: ClientRequestUpdatedEvent = { requestId: request.id, status: "CONFIRMED", updatedAt: now };
    const told = new Set([...(charge.lawyerId ? [charge.lawyerId] : []), ...(await OrganizationChargeRepo.findBillingAdmins(charge.organizationId))]);
    for (const userId of told) {
      emitToUser(userId, "client-request:updated", updated);
      await OrganizationChargeSvc.notify(userId, {
        organizationId: charge.organizationId,
        title: "The introduction fee couldn't be charged",
        message: `${charge.failureReason ?? "The card was declined."} The client is waiting: update the card, then retry from the request.`,
        link: `/client-requests/${request.id}`,
      });
    }
  }

  private static async notify(userId: string, n: { organizationId?: string; title: string; message: string; link: string }) {
    await NotificationSvc.create({ userId, type: "CLIENT_REQUEST", ...n }).catch((err) =>
      logger.error("Organization charge: failed to create notification", { err, userId }),
    );
  }
}
