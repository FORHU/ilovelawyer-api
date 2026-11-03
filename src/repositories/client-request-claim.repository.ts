import type { ClaimOutcome, Prisma, QuoteType, ReleaseReason } from "@prisma/client";
import prisma from "../lib/prisma";
import { ROUTING_WINDOW_MS } from "./client-request.repository";
import { CLIENT_REQUEST_MAX_LAWYERS, CLIENT_REQUEST_PICK_WINDOW_MS, CLIENT_REQUEST_UNPAID_FEE_HOURS } from "../constants/client-request.constants";

/** How long a lawyer who joined a request has to quote before their claim lapses (#511). */
export const CLAIM_HOLD_MS = 24 * 60 * 60 * 1000;

/** How long before a hold ends the lawyer holding it is reminded (#510). */
export const CLAIM_REMINDER_LEAD_MS = 2 * 60 * 60 * 1000;

/** Rolls the transaction back when the request or claim had already moved on. */
class RequestMovedOn extends Error {}

/** Why a lawyer couldn't join: CLOSED (not routed, its 48h over, or they're excluded from it), FULL
 * (CLIENT_REQUEST_MAX_LAWYERS already on it), or JOINED (they already are). */
export type JoinRefusal = "CLOSED" | "FULL" | "JOINED";

type Tx = Prisma.TransactionClient;

/* REQUEST_ROW_FIRST: every transaction that changes both a request and one of its claims (claim,
 * quote, release, decline, lapse, and ClientRequestRepo.withdraw) updates the request row before the
 * claim row (OrganizationChargeRepo too: request, then charge, then claim). Taking the locks in the
 * same order is what keeps two of them at once (a quote and the lapse sweep, a release and a
 * withdrawal) from deadlocking. The first update also serialises them: a second transaction waits on
 * the row, then re-checks what it read. */

/** Takes the request row's lock while it's still ROUTED (several lawyers: it stays ROUTED until the
 * client picks a quote). False when it isn't. */
async function lockRouted(tx: Tx, requestId: string, now: Date, where: Prisma.ClientRequestWhereInput = {}): Promise<boolean> {
  const { count } = await tx.clientRequest.updateMany({ where: { id: requestId, status: "ROUTED", ...where }, data: { updatedAt: now } });
  return count === 1;
}

/**
 * After a claim ends without an engagement: the lawyer isn't offered the request again, and its place
 * is free for another lawyer while the 48h are open. With no claim left open, the request goes back in
 * the pool for a fresh 48h, to be announced again, as when one lawyer held it. With no quote left
 * open, there's nothing for the client to pick, so no pick-by date.
 */
async function afterClaimEnded(tx: Tx, requestId: string, lawyerId: string, now: Date) {
  const open = await tx.clientRequestClaim.findMany({ where: { requestId, outcome: null }, select: { quotedAt: true } });
  await tx.clientRequest.update({
    where: { id: requestId },
    data: {
      excludedLawyerIds: { push: lawyerId },
      ...(open.length === 0 ? { routedAt: now, routingExpiresAt: new Date(now.getTime() + ROUTING_WINDOW_MS), announcedAt: null } : {}),
      ...(open.every((c) => !c.quotedAt) ? { pickByAt: null } : {}),
    },
  });
}

/** Ends one open claim on a ROUTED request (`claimWhere` narrows which: quoted, unquoted, expired),
 * then afterClaimEnded. Both or neither: false when the request or claim had moved on. */
async function endClaim(
  claim: { id: string; requestId: string; lawyerId: string },
  outcome: ClaimOutcome,
  now: Date,
  claimWhere: Prisma.ClientRequestClaimWhereInput = {},
  extra: Prisma.ClientRequestClaimUpdateManyMutationInput = {},
): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      if (!(await lockRouted(tx, claim.requestId, now))) throw new RequestMovedOn();
      const ended = await tx.clientRequestClaim.updateMany({ where: { id: claim.id, outcome: null, ...claimWhere }, data: { outcome, endedAt: now, ...extra } });
      if (ended.count !== 1) throw new RequestMovedOn();
      await afterClaimEnded(tx, claim.requestId, claim.lawyerId, now);
    });
    return true;
  } catch (err) {
    if (err instanceof RequestMovedOn) return false;
    throw err;
  }
}

/** A lawyer's place on a client request (ClientRequestClaim): they've joined it, can see the names
 * and quote within 24h; up to CLIENT_REQUEST_MAX_LAWYERS at once. */
export default class ClientRequestClaimRepo {
  /**
   * A lawyer joins a routed request (#511, several lawyers in phase 5): only while it's ROUTED, inside
   * its 48h, they aren't excluded from it, and fewer than CLIENT_REQUEST_MAX_LAWYERS hold it. The
   * request row's lock is taken first, so many joins at once are counted one after another and no
   * more than the most ever get in. `organizationId` null: a solo lawyer, with no organization
   * (docs/adr/0022).
   */
  static async claim(requestId: string, lawyerId: string, organizationId: string | null, now: Date = new Date()) {
    return prisma.$transaction(async (tx) => {
      const open = await lockRouted(tx, requestId, now, { routingExpiresAt: { gt: now }, NOT: { excludedLawyerIds: { has: lawyerId } } });
      if (!open) return { refused: "CLOSED" as JoinRefusal };
      const held = await tx.clientRequestClaim.findMany({ where: { requestId, outcome: null }, select: { lawyerId: true } });
      if (held.some((c) => c.lawyerId === lawyerId)) return { refused: "JOINED" as JoinRefusal };
      if (held.length >= CLIENT_REQUEST_MAX_LAWYERS) return { refused: "FULL" as JoinRefusal };
      const claim = await tx.clientRequestClaim.create({
        data: { requestId, lawyerId, organizationId, claimedAt: now, expiresAt: new Date(now.getTime() + CLAIM_HOLD_MS) },
      });
      return { claim, joined: held.length + 1 };
    });
  }

  /** Open, unquoted claims ending within the next 2h whose reminder hasn't gone out (#510). Only an
   * unquoted claim lapses (see findLapsed). */
  static async findDueReminders(now: Date) {
    return prisma.clientRequestClaim.findMany({
      where: { outcome: null, quotedAt: null, reminderSentAt: null, expiresAt: { gt: now, lte: new Date(now.getTime() + CLAIM_REMINDER_LEAD_MS) }, request: { status: "ROUTED" } },
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
   * Saves the lawyer's quote (#512), once, inside their 24h. The first quote on the request starts the
   * client's CLIENT_REQUEST_PICK_WINDOW_MS to pick one. Both or neither: false, with nothing changed,
   * when the claim already ended, its 24h ran out, it was quoted already, or the request is no longer
   * ROUTED (the client picked someone, withdrew, or it expired).
   */
  static async quote(
    claim: { id: string; requestId: string },
    quote: { type: QuoteType; amountMinor: number; currency: string; message: string },
    now: Date = new Date(),
  ): Promise<boolean> {
    try {
      await prisma.$transaction(async (tx) => {
        if (!(await lockRouted(tx, claim.requestId, now))) throw new RequestMovedOn();
        const saved = await tx.clientRequestClaim.updateMany({
          where: { id: claim.id, outcome: null, quotedAt: null, expiresAt: { gt: now } },
          data: { quoteType: quote.type, quoteAmountMinor: quote.amountMinor, quoteCurrency: quote.currency, quoteMessage: quote.message, quotedAt: now },
        });
        if (saved.count !== 1) throw new RequestMovedOn();
        await tx.clientRequest.updateMany({ where: { id: claim.requestId, pickByAt: null }, data: { pickByAt: new Date(now.getTime() + CLIENT_REQUEST_PICK_WINDOW_MS) } });
      });
      return true;
    } catch (err) {
      if (err instanceof RequestMovedOn) return false;
      throw err;
    }
  }

  /**
   * The lawyer gives the request back (#512): their claim ends RELEASED with the reason, they don't
   * see it again, and their place frees up (afterClaimEnded). Until the client picks a quote, quoted
   * or not. Both or neither.
   */
  static async release(claim: { id: string; requestId: string; lawyerId: string }, reason: { reason: ReleaseReason; note: string | null }, now: Date = new Date()): Promise<boolean> {
    return endClaim(claim, "RELEASED", now, {}, { releaseReason: reason.reason, releaseNote: reason.note });
  }

  /**
   * The client declines one lawyer's quote (#513): that claim ends DECLINED, with their reason if they
   * gave one, and the lawyer doesn't see the request again; the others carry on. Only a quoted claim.
   * Both or neither.
   */
  static async decline(claim: { id: string; requestId: string; lawyerId: string }, reason: string | null, now: Date = new Date()): Promise<boolean> {
    return endClaim(claim, "DECLINED", now, { quotedAt: { not: null } }, { declineReason: reason });
  }

  /**
   * Confirmed requests whose per-case fee is still FAILED `CLIENT_REQUEST_UNPAID_FEE_HOURS` after
   * the client confirmed (the fee's createdAt) (#933): the lawyer never fixed their card. A fee being
   * retried (PENDING) isn't one. With the open claim the fee is for (the only one left open once the
   * client has picked).
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
   * LAPSED and the request goes back in the pool for a fresh 48h without this lawyer, with no pick-by
   * date, as when nobody holds it. The failed fee stays in the fee history but stops being the
   * request's fee (feeRequestId cleared), so the next lawyer's confirmation records its own. Request,
   * then charge, then claim (REQUEST_ROW_FIRST). Both or neither: false when the client or a retry got
   * there first (the fee is no longer FAILED, or the request no longer CONFIRMED).
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
            pickByAt: null,
            excludedLawyerIds: { push: unpaid.claim.lawyerId },
          },
        });
        const fee = await tx.organizationCharge.updateMany({ where: { id: unpaid.chargeId, status: "FAILED" }, data: { feeRequestId: null } });
        const ended = await tx.clientRequestClaim.updateMany({ where: { id: unpaid.claim.id, outcome: null }, data: { outcome: "LAPSED", endedAt: now } });
        if (rerouted.count !== 1 || fee.count !== 1 || ended.count !== 1) throw new RequestMovedOn();
      });
      return true;
    } catch (err) {
      if (err instanceof RequestMovedOn) return false;
      throw err;
    }
  }

  /** Open claims whose 24h is over without a quote, on requests still ROUTED. A quoted claim doesn't
   * lapse: it waits for the client (until the pick-by date, ClientRequestRepo.findExpired). */
  static async findLapsed(now: Date) {
    return prisma.clientRequestClaim.findMany({
      where: { outcome: null, quotedAt: null, expiresAt: { lte: now }, request: { status: "ROUTED" } },
      select: { id: true, requestId: true, lawyerId: true, organizationId: true, expiresAt: true, request: { select: { caseId: true, clientId: true } } },
      orderBy: { expiresAt: "asc" },
    });
  }

  /**
   * Ends a claim whose 24h ran out without a quote as LAPSED (#510): the lawyer doesn't see the
   * request again, and their place frees up (afterClaimEnded). Both or neither: false, with nothing
   * changed, when the claim already ended or was quoted, or the request is no longer ROUTED.
   */
  static async lapse(claim: { id: string; requestId: string; lawyerId: string }, now: Date = new Date()): Promise<boolean> {
    return endClaim(claim, "LAPSED", now, { quotedAt: null, expiresAt: { lte: now } });
  }
}
