import prisma from "../lib/prisma";
import { ROUTING_WINDOW_MS } from "./client-request.repository";

/** How long a claim holds a request before it lapses back to the pool (#511). */
export const CLAIM_HOLD_MS = 24 * 60 * 60 * 1000;

/** How long before a hold ends the lawyer holding it is reminded (#510). */
export const CLAIM_REMINDER_LEAD_MS = 2 * 60 * 60 * 1000;

/** Rolls the lapse's transaction back when the request had already moved on. */
class RequestMovedOn extends Error {}

/** A lawyer's 24h hold on a client request (ClientRequestClaim). */
export default class ClientRequestClaimRepo {
  /**
   * The first claim on a routed request wins (#511). The request moves ROUTED -> CLAIMED only if
   * it's still routed, inside its 48h window, and the lawyer isn't excluded from it; the claim is
   * written in the same transaction. Two claims at once both try the update: Postgres makes the
   * second wait on the row, then re-checks `status` and finds it CLAIMED, so only one row ever
   * moves. Null when this lawyer didn't win; the caller works out why.
   */
  static async claim(requestId: string, lawyerId: string, organizationId: string, now: Date = new Date()) {
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

  /** Open claims whose 24h is over, on requests still CLAIMED. A QUOTED request's hold isn't
   * lapsed: whether it should be is still open (#512). */
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
        const ended = await tx.clientRequestClaim.updateMany({
          where: { id: claim.id, outcome: null },
          data: { outcome: "LAPSED", endedAt: now, openRequestId: null },
        });
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
        if (ended.count !== 1 || rerouted.count !== 1) throw new RequestMovedOn();
      });
      return true;
    } catch (err) {
      if (err instanceof RequestMovedOn) return false;
      throw err;
    }
  }
}
