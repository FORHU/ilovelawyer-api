import type { OrganizationCharge, OrganizationChargeKind, OrganizationChargeRefund } from "@prisma/client";
import type Stripe from "stripe";
import OrganizationChargeRepo from "../repositories/organization-charge.repository";
import OrganizationBillingRepo, { payerOf } from "../repositories/organization-billing.repository";
import OrganizationRepo from "../repositories/organization.repository";
import ClientRequestRepo from "../repositories/client-request.repository";
import { organizationCardProviderNamed, type CardChargeResult } from "../payments/organization-card-provider";
import EngagementAccessSvc from "./engagement-access.service";
import EngagementAiBudgetSvc from "./engagement-ai-budget.service";
import NotificationSvc from "./notification.service";
import { emitToUser } from "../lib/socket";
import logger from "../utils/logger";
import HttpError from "../utils/http-error";
import { CLIENT_REQUEST_PER_CASE_FEE_MINOR, ENGAGEMENT_AI_TOP_UP_PACKS } from "../constants/client-request.constants";
import { CLIENT_HANDOFF_SOCKET_EVENTS, type ClientRequestUpdatedEvent, type EngagementAiBudgetEvent } from "../types/client-handoff";

const NO_CARD = "There's no card on file. An owner or admin can add one in the organization's billing settings.";
/** A solo lawyer pays with their own card (docs/adr/0022). */
const NO_OWN_CARD = "There's no card on file. Add one in your profile's billing settings.";
const UNREACHABLE = "We couldn't reach the payment provider. Try again in a moment.";

export type ChargeOutcome = "SUCCEEDED" | "PENDING" | "FAILED";

type SettledCharge = Pick<OrganizationCharge, "id" | "kind" | "requestId" | "organizationId" | "lawyerId" | "failureReason">;

/** Charge in the contract: one of a firm's charges, with what's been refunded of it (#520). Shared by
 * the firm's fee history and the admin app. */
export function chargeDto(c: OrganizationCharge & { refunds: OrganizationChargeRefund[] }, lawyerName: string | null) {
  const refunded = c.refunds.filter((r) => r.status === "SUCCEEDED").reduce((sum, r) => sum + r.amountMinor, 0);
  return {
    id: c.id,
    kind: c.kind,
    status: c.status,
    amount: { amountMinor: c.amountMinor, currency: c.currency },
    /** An AI top-up's credit to the engagement's AI budget (#516); null on a per-case fee. */
    credit: c.creditMinor === null ? null : { amountMinor: c.creditMinor, currency: c.currency },
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
 * never charged for real. AI top-ups (#516) charge the same way, to the same card, and add their
 * credit to the engagement's AI budget once paid.
 */
export default class OrganizationChargeSvc {
  /** What confirming a lawyer charges their organization. A placeholder until the price is signed off
   * (FORHU/ilovelawyer-app#846). */
  static perCaseFee() {
    return { amountMinor: CLIENT_REQUEST_PER_CASE_FEE_MINOR, currency: "GBP" };
  }

  /** The AI top-up packs on offer (TopUpPack in the contract). Placeholders until #846. */
  static topUpPacks() {
    return ENGAGEMENT_AI_TOP_UP_PACKS.map((p) => ({
      id: p.id,
      price: { amountMinor: p.priceMinor, currency: p.currency },
      credit: { amountMinor: p.creditMinor, currency: p.currency },
    }));
  }

  /**
   * Buys an AI top-up pack for an engaged request (#516), after the lawyer has approved it: never
   * automatic. Charged to the same payer as the per-case fee (the firm, or a solo lawyer's own
   * card), at once. The credit counts once the payment goes through, from Stripe's direct answer or
   * its webhook (applyStripeIntent). Returns the charge after that attempt: SUCCEEDED, or PENDING
   * while the bank decides. 402 CARD_REQUIRED with no card on file (nothing is recorded), 402
   * CHARGE_FAILED when declined (the failed charge stays in the fee history), 409 while the
   * request isn't engaged or another top-up is still being charged.
   */
  static async buyTopUp(input: { requestId: string; organizationId: string | null; lawyerId: string; packId: string }): Promise<OrganizationCharge> {
    const pack = ENGAGEMENT_AI_TOP_UP_PACKS.find((p) => p.id === input.packId);
    if (!pack) throw new HttpError("There's no top-up pack with that id.", 400);
    const billing = await OrganizationBillingRepo.find(payerOf(input.organizationId, input.lawyerId)!);
    if (!billing?.paymentMethodId) throw new HttpError(input.organizationId ? NO_CARD : NO_OWN_CARD, 402, "CARD_REQUIRED");

    const charge = await OrganizationChargeRepo.createTopUp({
      requestId: input.requestId,
      organizationId: input.organizationId,
      lawyerId: input.lawyerId,
      amountMinor: pack.priceMinor,
      creditMinor: pack.creditMinor,
      currency: pack.currency,
    });
    if (charge === null) throw new HttpError("This request isn't engaged.", 409, "INVALID_REQUEST_STATUS");
    if (charge === "BUSY") throw new HttpError("A top-up is already being charged. Wait for it to finish.", 409, "INVALID_REQUEST_STATUS", { chargeStatus: "PENDING" });

    const outcome = await OrganizationChargeSvc.attempt(charge.id);
    const after = (await OrganizationChargeRepo.findById(charge.id))!;
    if (outcome === "FAILED") throw new HttpError(after.failureReason ?? "The card was declined.", 402, "CHARGE_FAILED");
    return after;
  }

  /**
   * One attempt at a charge, then whatever follows from it (engaging the request, or telling the firm
   * the card was declined). Returns how it ended; null when another attempt is already running or it
   * had already gone through.
   */
  static async attempt(chargeId: string): Promise<ChargeOutcome | null> {
    const charge = await OrganizationChargeRepo.findById(chargeId);
    if (!charge) return null;
    // The firm's card, or for a solo lawyer (no organization) their own.
    const payer = payerOf(charge.organizationId, charge.lawyerId);
    const billing = payer ? await OrganizationBillingRepo.find(payer) : null;
    if (!billing?.paymentMethodId) {
      const reason = charge.organizationId ? NO_CARD : NO_OWN_CARD;
      await OrganizationChargeRepo.failWithoutAttempt(chargeId, reason);
      await OrganizationChargeSvc.after({ ...charge, failureReason: reason }, "FAILED", false);
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
        metadata: {
          ...(charge.organizationId ? { organizationId: charge.organizationId } : charge.lawyerId ? { lawyerId: charge.lawyerId } : {}),
          ...(charge.requestId ? { requestId: charge.requestId } : {}),
        },
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

  /** A solo lawyer's own fee history (charges with no organization), newest first. */
  static async listForLawyer(lawyerId: string, query: { kind?: OrganizationChargeKind; page: number; limit: number }) {
    const { total, data } = await OrganizationChargeRepo.listForLawyer(lawyerId, query.kind, query.page, query.limit);
    const names = new Map((await OrganizationChargeRepo.findUserNames([lawyerId])).map((u) => [u.id, u.name || u.email] as const));
    return { total, data: data.map((c) => chargeDto(c, names.get(lawyerId) ?? null)) };
  }

  private static async readStripe(paymentIntentId: string): Promise<CardChargeResult | null> {
    const stripe = organizationCardProviderNamed("STRIPE");
    if (stripe.mode !== "hosted") return null;
    return stripe.chargeStatus(paymentIntentId);
  }

  /** What follows a settled charge. For a per-case fee: engaged, both sides are told; declined, the
   * lawyer and the organization's owners and admins are told to update the card. For a top-up, see
   * afterTopUp. */
  private static async after(charge: SettledCharge, outcome: ChargeOutcome, engaged: boolean) {
    if (charge.kind === "AI_TOP_UP") return OrganizationChargeSvc.afterTopUp(charge, outcome);
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
    // A solo lawyer's charge has no organization: only they are told.
    const admins = charge.organizationId ? await OrganizationChargeRepo.findBillingAdmins(charge.organizationId) : [];
    const told = new Set([...(charge.lawyerId ? [charge.lawyerId] : []), ...admins]);
    for (const userId of told) {
      emitToUser(userId, "client-request:updated", updated);
      await OrganizationChargeSvc.notify(userId, {
        organizationId: charge.organizationId ?? undefined,
        title: "The introduction fee couldn't be charged",
        message: `${charge.failureReason ?? "The card was declined."} The client is waiting: update the card, then retry from the request.`,
        link: `/client-requests/${request.id}`,
      });
    }
  }

  /** A top-up that went through: the lawyer's AI meter is sent the new budget (engagement:ai-budget),
   * so blocked AI work can carry on. One that was declined, perhaps later by the bank: the lawyer is
   * told no credit was added. Nobody else is waiting on it. */
  private static async afterTopUp(charge: SettledCharge, outcome: ChargeOutcome) {
    if (!charge.requestId || !charge.lawyerId || outcome === "PENDING") return;
    if (outcome === "SUCCEEDED") {
      const request = await ClientRequestRepo.findForLawyer(charge.requestId);
      const budget = await EngagementAiBudgetSvc.forRequest(charge.requestId, request?.copyCaseId ?? null);
      const event: EngagementAiBudgetEvent = { requestId: charge.requestId, percentUsed: budget.percentUsed, state: budget.state };
      emitToUser(charge.lawyerId, CLIENT_HANDOFF_SOCKET_EVENTS.ENGAGEMENT_AI_BUDGET, event);
      return;
    }
    await OrganizationChargeSvc.notify(charge.lawyerId, {
      organizationId: charge.organizationId ?? undefined,
      title: "Your AI top-up couldn't be charged",
      message: `${charge.failureReason ?? "The card was declined."} No AI credit was added.`,
      link: `/client-requests/${charge.requestId}`,
    });
  }

  private static async notify(userId: string, n: { organizationId?: string; title: string; message: string; link: string }) {
    await NotificationSvc.create({ userId, type: "CLIENT_REQUEST", ...n }).catch((err) =>
      logger.error("Organization charge: failed to create notification", { err, userId }),
    );
  }
}
