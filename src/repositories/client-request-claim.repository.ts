import type { QuoteType, ReleaseReason } from "@prisma/client";
import prisma from "../lib/prisma";
import { ROUTING_WINDOW_MS } from "./client-request.repository";
import { CLIENT_REQUEST_UNPAID_FEE_HOURS } from "../constants/client-request.constants";

/** How long a claim holds a request before it lapses back to the pool (#511). */
export const CLAIM_HOLD_MS = 24 * 60 * 60 * 1000;

/** How long before a hold ends the lawyer holding it is reminded (#510). */
export const CLAIM_REMINDER_LEAD_MS = 2 * 60 * 60 * 1000;

/** Rolls the lapse's transaction back when the request had already moved on. */
class RequestMovedOn extends Error {}

/* REQUEST_ROW_FIRST: every transaction that changes both a request and one of its claims (claim,
 * quote, release, lapse, and ClientRequestRepo.withdraw) updates the request row before the claim
 * row (OrganizationChargeRepo too: request, then charge, then claim). Taking the locks in the same order is what keeps two of them at once (a quote and the
 * lapse sweep, a release and a withdrawal) from deadlocking. */

/** A lawyer's 24h hold on a client request (ClientRequestClaim). */
export default class ClientRequestClaimRepo {
  /**
   * The first claim on a routed request wins (#511). The request moves ROUTED -> CLAIMED only if
   * it's still routed, inside its 48h window, and the lawyer isn't excluded from it; the claim is
   * written in the same transaction. Two claims at once both try the update: Postgres makes the
   * second wait on the row, then re-checks `status` and finds it CLAIMED, so only one row ever
   * moves. Null when this lawyer didn't win; the caller works out why.
   */
  /** `organizationId` null: a solo lawyer, with no organization (docs/adr/0022). */
  static async claim(requestId: string, lawyerId: string, organizationId: string | null, now: Date = new Date()) {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.clientRequest.updateMany({
        where: { id: requestId, status: "ROUTED", routingExpiresAt: { gt: now }, NOT: { excludedLawyerIds: { has: lawyerId } } },
        data: { status: "CLAIMED" },
      });
      if (count !== 1) return null;
      return tx.clientRequestClaim.create({
        data: { requestId, openRequestId: requestId, lawyerId, organizationId, claimedAt: now, expiresAt: new Date(now.getTime() + CLAIM_HOLD_MS) },
      });
    });
  }

  /** Open claims on CLAIMED requests ending within the next 2h whose reminder hasn't gone out
   * (#510). Only CLAIMED, since only a CLAIMED hold lapses (see findLapsed). */
  static async findDueReminders(now: Date) {
    return prisma.clientRequestClaim.findMany({
      where: { outcome: null, reminderSentAt: null, expiresAt: { gt: now, lte: new Date(now.getTime() + CLAIM_REMINDER_LEAD_MS) }, request: { status: "CLAIMED" } },
      select: { id: true, requestId: true, lawyerId: true, expiresAt: true, lawyer: { select: { email: true } } },
      orderBy: { expiresAt: "asc" },
    });
  }

  /** Takes the right to send a claim's reminder: true for exactly one caller, before it's sent. */
  static async markReminderSent(id: string, now: Date): Promise<boolean> {
    const { count } = await prisma.clientRequestClaim.updateMany({ where: { id, outcome: null, reminderSentAt: null }, data: { reminderSentAt: now } });
    return count === 1;
  }

  /**
   * Saves the lawyer's quote and moves the request CLAIMED -> QUOTED (#512). Both or neither: false,
   * with nothing changed, when the claim already ended or its 24h ran out, or the request is no
   * longer CLAIMED (a second quote, a withdrawal, the lapse sweep got there first).
   */
  static async quote(
    claim: { id: string; requestId: string },
    quote: { type: QuoteType; amountMinor: number; currency: string; message: string },
    now: Date = new Date(),
  ): Promise<boolean> {
    try {
      await prisma.$transaction(async (tx) => {
        const quoted = await tx.clientRequest.updateMany({ where: { id: claim.requestId, status: "CLAIMED" }, data: { status: "QUOTED" } });
        const saved = await tx.clientRequestClaim.updateMany({
          where: { id: claim.id, outcome: null, expiresAt: { gt: now } },
          data: { quoteType: quote.type, quoteAmountMinor: quote.amountMinor, quoteCurrency: quote.currency, quoteMessage: quote.message, quotedAt: now },
        });
        if (quoted.count !== 1 || saved.count !== 1) throw new RequestMovedOn();
      });
      return true;
    } catch (err) {
      if (err instanceof RequestMovedOn) return false;
      throw err;
    }
  }

  /**
   * The lawyer gives the request back (#512): the claim ends RELEASED with the reason, and the
   * request goes back in the pool as a lapse does (ROUTED for another 48h, this lawyer excluded, to
   * be announced again). From CLAIMED, or QUOTED before the client has answered. Both or neither.
   */
  static async release(
    claim: { id: string; requestId: string; lawyerId: string },
    reason: { reason: ReleaseReason; note: string | null },
    now: Date = new Date(),
  ): Promise<boolean> {
    try {
      await prisma.$transaction(async (tx) => {
        // Request row first, as everywhere (see REQUEST_ROW_FIRST).
        const rerouted = await tx.clientRequest.updateMany({
          where: { id: claim.requestId, status: { in: ["CLAIMED", "QUOTED"] } },
          data: {
            status: "ROUTED",
            routedAt: now,
            routingExpiresAt: new Date(now.getTime() + ROUTING_WINDOW_MS),
            announcedAt: null,
            excludedLawyerIds: { push: claim.lawyerId },
          },
        });
        const ended = await tx.clientRequestClaim.updateMany({
          where: { id: claim.id, outcome: null },
          data: { outcome: "RELEASED", endedAt: now, openRequestId: null, releaseReason: reason.reason, releaseNote: reason.note },
        });
        if (ended.count !== 1 || rerouted.count !== 1) throw new RequestMovedOn();
      });
      return true;
    } catch (err) {
      if (err instanceof RequestMovedOn) return false;
      throw err;
    }
  }

  /**
   * The client declines the quote (#513): the claim ends DECLINED, with their reason if they gave one,
   * and the request goes back in the pool without that lawyer, as a release does. Only from QUOTED.
   * Both or neither.
   */
  static async decline(claim: { id: string; requestId: string; lawyerId: string }, reason: string | null, now: Date = new Date()): Promise<boolean> {
    try {
      await prisma.$transaction(async (tx) => {
        // Request row first, as everywhere (see REQUEST_ROW_FIRST).
        const rerouted = await tx.clientRequest.updateMany({
          where: { id: claim.requestId, status: "QUOTED" },
          data: {
            status: "ROUTED",
            routedAt: now,
            routingExpiresAt: new Date(now.getTime() + ROUTING_WINDOW_MS),
            announcedAt: null,
            excludedLawyerIds: { push: claim.lawyerId },
          },
        });
        const ended = await tx.clientRequestClaim.updateMany({
          where: { id: claim.id, outcome: null },
          data: { outcome: "DECLINED", endedAt: now, openRequestId: null, declineReason: reason },
        });
        if (ended.count !== 1 || rerouted.count !== 1) throw new RequestMovedOn();
      });
      return true;
    } catch (err) {
      if (err instanceof RequestMovedOn) return false;
      throw err;
    }
  }

  /**
   * Confirmed requests whose per-case fee is still FAILED `CLIENT_REQUEST_UNPAID_FEE_HOURS` after
   * the client confirmed (the fee's createdAt) (#933): the lawyer never fixed their card. A fee being
   * retried (PENDING) isn't one. With the open claim the fee is for.
   */
  static async findUnpaid(now: Date) {
    const rows = await prisma.organizationCharge.findMany({
      where: {
        kind: "PER_CASE_FEE",
        status: "FAILED",
        feeRequestId: { not: null },
        createdAt: { lte: new Date(now.getTime() - CLIENT_REQUEST_UNPAID_FEE_HOURS * 60 * 60 * 1000) },
        request: { status: "CONFIRMED" },
      },
      select: {
        id: true,
        requestId: true,
        request: { select: { caseId: true, clientId: true, claims: { where: { outcome: null }, select: { id: true, lawyerId: true, organizationId: true } } } },
      },
      orderBy: { createdAt: "asc" },
    });
    return rows.flatMap((r) => {
      const claim = r.request?.claims[0];
      return claim && r.requestId ? [{ chargeId: r.id, requestId: r.requestId, claim, caseId: r.request!.caseId, clientId: r.request!.clientId }] : [];
    });
  }

  /**
   * Gives a confirmed request back because its per-case fee was never paid (#933): the claim ends
   * LAPSED and the request goes back in the pool without this lawyer, as a lapse does. The failed fee
   * stays in the fee history but stops being the request's fee (feeRequestId cleared), so the next
   * lawyer's confirmation records its own. Request, then charge, then claim (REQUEST_ROW_FIRST). Both
   * or neither: false when the client or a retry got there first (the fee is no longer FAILED, or the
   * request no longer CONFIRMED).
   */
  static async lapseUnpaid(unpaid: { chargeId: string; requestId: string; claim: { id: string; lawyerId: string } }, now: Date = new Date()): Promise<boolean> {
    try {
      await prisma.$transaction(async (tx) => {
        const rerouted = await tx.clientRequest.updateMany({
          where: { id: unpaid.requestId, status: "CONFIRMED" },
          data: {
            status: "ROUTED",
            routedAt: now,
            routingExpiresAt: new Date(now.getTime() + ROUTING_WINDOW_MS),
            announcedAt: null,
            excludedLawyerIds: { push: unpaid.claim.lawyerId },
          },
        });
        const fee = await tx.organizationCharge.updateMany({ where: { id: unpaid.chargeId, status: "FAILED" }, data: { feeRequestId: null } });
        const ended = await tx.clientRequestClaim.updateMany({
          where: { id: unpaid.claim.id, outcome: null },
          data: { outcome: "LAPSED", endedAt: now, openRequestId: null },
        });
        if (rerouted.count !== 1 || fee.count !== 1 || ended.count !== 1) throw new RequestMovedOn();
      });
      return true;
    } catch (err) {
      if (err instanceof RequestMovedOn) return false;
      throw err;
    }
  }

  /** Open claims whose 24h is over, on requests still CLAIMED. A QUOTED request's hold isn't
   * lapsed: once the lawyer has quoted, it waits for the client to answer (#512, #513). */
  static async findLapsed(now: Date) {
    return prisma.clientRequestClaim.findMany({
      where: { outcome: null, expiresAt: { lte: now }, request: { status: "CLAIMED" } },
      select: { id: true, requestId: true, lawyerId: true, organizationId: true, expiresAt: true, request: { select: { caseId: true, clientId: true } } },
      orderBy: { expiresAt: "asc" },
    });
  }

  /**
   * Ends the claim as LAPSED and puts the request back in the pool: ROUTED for another 48h, the
   * lawyer who held it excluded, and not yet announced again (#510). Both or neither: false, with
   * nothing changed, when the claim already ended or the request is no longer CLAIMED (a quote, a
   * withdrawal, another sweep got there first).
   */
  static async lapse(claim: { id: string; requestId: string; lawyerId: string }, now: Date = new Date()): Promise<boolean> {
    try {
      await prisma.$transaction(async (tx) => {
        // Request row first, as everywhere (see REQUEST_ROW_FIRST).
        const rerouted = await tx.clientRequest.updateMany({
          where: { id: claim.requestId, status: "CLAIMED" },
          data: {
            status: "ROUTED",
            routedAt: now,
            routingExpiresAt: new Date(now.getTime() + ROUTING_WINDOW_MS),
            announcedAt: null,
            excludedLawyerIds: { push: claim.lawyerId },
          },
        });
        const ended = await tx.clientRequestClaim.updateMany({
          where: { id: claim.id, outcome: null },
          data: { outcome: "LAPSED", endedAt: now, openRequestId: null },
        });
        if (ended.count !== 1 || rerouted.count !== 1) throw new RequestMovedOn();
      });
      return true;
    } catch (err) {
      if (err instanceof RequestMovedOn) return false;
      throw err;
    }
  }
}
