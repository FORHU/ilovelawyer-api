import type { ClaimOutcome, Prisma, Quotation, QuotationStatus, QuoteType } from "@prisma/client";
import prisma from "../lib/prisma";
import { afterClaimEnded, endClaim, lockRouted } from "./client-request-claim.repository";
import { ROUTING_WINDOW_MS } from "./client-request.repository";
import { platformFeeOf } from "../constants/payout.constants";

type Tx = Prisma.TransactionClient;

/** Why a quotation couldn't move on: CLOSED (the request, claim or quotation had moved on), EXPIRED
 * (the lawyer's expiry passed), or SENT (a draft edit after it was sent). */
export type QuotationRefusal = "CLOSED" | "EXPIRED" | "SENT";

/** Rolls a transaction back, with why. */
class MovedOn extends Error {
  constructor(readonly refusal: QuotationRefusal = "CLOSED") {
    super(refusal);
  }
}

async function refusing<T>(run: () => Promise<T>): Promise<T | { refused: QuotationRefusal }> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof MovedOn) return { refused: err.refusal };
    throw err;
  }
}

/** A quotation still waiting on someone: the lawyer (DRAFT) or the client (SENT). */
export const OPEN_QUOTATION_STATUSES: QuotationStatus[] = ["DRAFT", "SENT"];

type ClosedStatus = Extract<QuotationStatus, "REJECTED" | "WITHDRAWN" | "EXPIRED" | "NOT_CHOSEN">;

/** What a quotation becomes when its claim ends with `outcome` before anyone paid. */
export function quotationStatusFor(outcome: ClaimOutcome): ClosedStatus {
  if (outcome === "DECLINED") return "REJECTED";
  if (outcome === "NOT_CHOSEN") return "NOT_CHOSEN";
  return "WITHDRAWN";
}

/** Closes the open quotations `where` matches, inside a caller's transaction. Returns how many. */
export async function closeOpenQuotations(tx: Tx, where: Prisma.QuotationWhereInput, status: ClosedStatus, now: Date, rejectReason?: string | null): Promise<number> {
  const { count } = await tx.quotation.updateMany({
    where: { ...where, status: { in: OPEN_QUOTATION_STATUSES } },
    data: { status, closedAt: now, ...(status === "REJECTED" ? { rejectedAt: now, rejectReason: rejectReason ?? null } : {}) },
  });
  return count;
}

export interface QuotationDraft {
  type: QuoteType;
  serviceFeeMinor: number;
  currency: string;
  message: string;
  expiresAt: Date;
}

export interface FeeTerms {
  platformFeeBps: number;
  minPlatformFeeMinor: number;
}

function priced(serviceFeeMinor: number, terms: FeeTerms) {
  const platformFeeMinor = platformFeeOf(serviceFeeMinor, terms.platformFeeBps, terms.minPlatformFeeMinor);
  return { platformFeeBps: terms.platformFeeBps, platformFeeMinor, totalAmountMinor: serviceFeeMinor + platformFeeMinor };
}

/**
 * The lawyer's quotation on their claim (Quotation), through the client accepting it. Every
 * transaction takes the request row first (REQUEST_ROW_FIRST in client-request-claim.repository.ts),
 * then the quotation, then the claims, like everything else that changes a request and its claims.
 */
export default class QuotationRepo {
  static async findById(id: string) {
    return prisma.quotation.findUnique({ where: { id } });
  }

  static async findForClaim(claimId: string) {
    return prisma.quotation.findUnique({ where: { claimId } });
  }

  /** The accepted quotation a confirmed request is waiting on payment for. */
  static async findAcceptedForRequest(requestId: string) {
    return prisma.quotation.findFirst({ where: { requestId, status: { in: ["ACCEPTED", "PAID"] } }, orderBy: { acceptedAt: "desc" } });
  }

  /**
   * Creates or edits the lawyer's draft, priced with the tenant's terms as they are now (sending
   * prices it again). Only while the request is ROUTED, the claim open, inside its 24h, and no quote
   * sent: refused SENT once it has been.
   */
  static async saveDraft(claim: { id: string; requestId: string; lawyerId: string }, draft: QuotationDraft, terms: FeeTerms, now: Date = new Date()) {
    return refusing(() =>
      prisma.$transaction(async (tx) => {
        if (!(await lockRouted(tx, claim.requestId, now))) throw new MovedOn();
        const open = await tx.clientRequestClaim.findFirst({ where: { id: claim.id, outcome: null, expiresAt: { gt: now } }, select: { id: true } });
        if (!open) throw new MovedOn();
        const existing = await tx.quotation.findUnique({ where: { claimId: claim.id }, select: { status: true } });
        if (existing && existing.status !== "DRAFT") throw new MovedOn("SENT");
        const data = { ...draft, ...priced(draft.serviceFeeMinor, terms) };
        return tx.quotation.upsert({
          where: { claimId: claim.id },
          create: { claimId: claim.id, requestId: claim.requestId, lawyerId: claim.lawyerId, ...data },
          update: data,
        });
      }),
    );
  }

  /**
   * Sends the draft to the client: SENT, priced again with the tenant's terms now, which then stay
   * with it. Inside the claim's 24h and before its own expiry. The claim's quote columns are kept in
   * step (the lapse and the reminder read quotedAt), and the request's pick-by date moves out to this
   * quote's expiry if that's later, so the request doesn't expire under a quote that's still good.
   */
  static async send(claim: { id: string; requestId: string }, terms: FeeTerms, now: Date = new Date()) {
    return refusing(() =>
      prisma.$transaction(async (tx) => {
        if (!(await lockRouted(tx, claim.requestId, now))) throw new MovedOn();
        const draft = await tx.quotation.findUnique({ where: { claimId: claim.id } });
        if (!draft) throw new MovedOn();
        if (draft.status !== "DRAFT") throw new MovedOn("SENT");
        if (draft.expiresAt <= now) throw new MovedOn("EXPIRED");
        const sent = await tx.quotation.update({ where: { id: draft.id }, data: { ...priced(draft.serviceFeeMinor, terms), status: "SENT", sentAt: now } });
        const quoted = await tx.clientRequestClaim.updateMany({
          where: { id: claim.id, outcome: null, quotedAt: null, expiresAt: { gt: now } },
          data: { quoteType: sent.type, quoteAmountMinor: sent.serviceFeeMinor, quoteCurrency: sent.currency, quoteMessage: sent.message, quotedAt: now },
        });
        if (quoted.count !== 1) throw new MovedOn();
        const request = await tx.clientRequest.findUniqueOrThrow({ where: { id: claim.requestId }, select: { pickByAt: true } });
        if (!request.pickByAt || request.pickByAt < sent.expiresAt) await tx.clientRequest.update({ where: { id: claim.requestId }, data: { pickByAt: sent.expiresAt } });
        return sent;
      }),
    );
  }

  /**
   * The client accepts one SENT quotation, before its expiry: the request is CONFIRMED (waiting on the
   * client's payment), the quotation ACCEPTED with the total copied to acceptedAmountMinor, which
   * never changes after, and every other lawyer on the request ends NOT_CHOSEN with their quotations.
   * `notChosen`: those lawyers, to tell.
   */
  static async accept(requestId: string, quotationId: string, now: Date = new Date()) {
    return refusing(() =>
      prisma.$transaction(async (tx) => {
        const { count } = await tx.clientRequest.updateMany({ where: { id: requestId, status: "ROUTED" }, data: { status: "CONFIRMED" } });
        if (count !== 1) throw new MovedOn();
        const quotation = await tx.quotation.findFirst({ where: { id: quotationId, requestId, status: "SENT" } });
        if (!quotation) throw new MovedOn();
        if (quotation.expiresAt <= now) throw new MovedOn("EXPIRED");
        const claim = await tx.clientRequestClaim.findFirst({ where: { id: quotation.claimId, outcome: null } });
        if (!claim) throw new MovedOn();
        const accepted = await tx.quotation.update({
          where: { id: quotation.id },
          data: { status: "ACCEPTED", acceptedAt: now, acceptedAmountMinor: quotation.totalAmountMinor },
        });
        const others = await tx.clientRequestClaim.findMany({ where: { requestId, outcome: null, id: { not: claim.id } }, select: { lawyerId: true } });
        await tx.clientRequestClaim.updateMany({ where: { requestId, outcome: null, id: { not: claim.id } }, data: { outcome: "NOT_CHOSEN", endedAt: now } });
        await closeOpenQuotations(tx, { requestId, id: { not: quotation.id } }, "NOT_CHOSEN", now);
        return { quotation: accepted, claim, notChosen: others.map((c) => c.lawyerId) };
      }),
    );
  }

  /** An accepted quotation with nothing to pay (a free first consultation): PAID and the request
   * ENGAGED at once, the claim with it. False when it had moved on. */
  static async engageUnpaid(quotation: Pick<Quotation, "id" | "requestId" | "claimId">, now: Date = new Date()): Promise<boolean> {
    const done = await refusing(() =>
      prisma.$transaction(async (tx) => {
        const engaged = await tx.clientRequest.updateMany({ where: { id: quotation.requestId, status: "CONFIRMED" }, data: { status: "ENGAGED", engagedAt: now } });
        if (engaged.count !== 1) throw new MovedOn();
        const paid = await tx.quotation.updateMany({ where: { id: quotation.id, status: "ACCEPTED", acceptedAmountMinor: 0 }, data: { status: "PAID", paidAt: now } });
        if (paid.count !== 1) throw new MovedOn();
        await tx.clientRequestClaim.updateMany({ where: { id: quotation.claimId, outcome: null }, data: { outcome: "ENGAGED", openRequestId: null } });
        return true;
      }),
    );
    return done === true;
  }

  /** Quotations whose lawyer-set expiry has passed while still waiting on the client: SENT on a
   * routed request, or ACCEPTED but unpaid on a confirmed one. With who to tell. */
  static async findExpired(now: Date) {
    return prisma.quotation.findMany({
      where: {
        expiresAt: { lte: now },
        OR: [
          { status: "SENT", request: { status: "ROUTED" }, claim: { outcome: null } },
          { status: "ACCEPTED", request: { status: "CONFIRMED" } },
        ],
      },
      select: {
        id: true,
        status: true,
        requestId: true,
        claimId: true,
        lawyerId: true,
        expiresAt: true,
        claim: { select: { organizationId: true } },
        request: { select: { caseId: true, clientId: true } },
      },
      orderBy: { expiresAt: "asc" },
    });
  }

  /** A SENT quotation past its expiry: it EXPIRES and the lawyer's claim ends NOT_CHOSEN (the client
   * didn't pick it in time), freeing their place as any ended claim does. */
  static async expireSent(q: { id: string; claimId: string; requestId: string; lawyerId: string }, now: Date = new Date()) {
    return endClaim({ id: q.claimId, requestId: q.requestId, lawyerId: q.lawyerId }, "NOT_CHOSEN", now, {}, {}, { where: { id: q.id, status: "SENT", expiresAt: { lte: now } }, status: "EXPIRED" });
  }

  /**
   * An ACCEPTED quotation the client didn't pay before its expiry: it EXPIRES, any payment still
   * waiting on the client is CANCELED, the lawyer's claim ends NOT_CHOSEN, and the request goes back
   * to ROUTED for a fresh 48h without them, to be announced again. The caller has already cancelled the
   * open PaymentIntent at Stripe; a payment that went through stops this (the money was taken, so the
   * engagement stands). Both or neither.
   */
  static async expireAccepted(q: { id: string; claimId: string; requestId: string; lawyerId: string }, now: Date = new Date()): Promise<boolean> {
    const done = await refusing(() =>
      prisma.$transaction(async (tx) => {
        const rerouted = await tx.clientRequest.updateMany({
          where: { id: q.requestId, status: "CONFIRMED" },
          data: {
            status: "ROUTED",
            routedAt: now,
            routingExpiresAt: new Date(now.getTime() + ROUTING_WINDOW_MS),
            announcedAt: null,
            pickByAt: null,
            excludedLawyerIds: { push: q.lawyerId },
          },
        });
        if (rerouted.count !== 1) throw new MovedOn();
        const paid = await tx.quotationPayment.count({ where: { quotationId: q.id, status: { notIn: ["PENDING", "FAILED", "CANCELED"] } } });
        if (paid > 0) throw new MovedOn();
        const expired = await tx.quotation.updateMany({ where: { id: q.id, status: "ACCEPTED", expiresAt: { lte: now } }, data: { status: "EXPIRED", closedAt: now } });
        if (expired.count !== 1) throw new MovedOn();
        await tx.quotationPayment.updateMany({ where: { quotationId: q.id, status: "PENDING" }, data: { status: "CANCELED", failureReason: "The quote expired before it was paid." } });
        await tx.clientRequestClaim.updateMany({ where: { id: q.claimId, outcome: null }, data: { outcome: "NOT_CHOSEN", endedAt: now } });
        return true;
      }),
    );
    return done === true;
  }

  /** The lawyer takes back a SENT quotation: it's WITHDRAWN and their claim ends RELEASED, as giving
   * the request back does. */
  static async withdraw(claim: { id: string; requestId: string; lawyerId: string }, now: Date = new Date()): Promise<boolean> {
    const done = await refusing(() =>
      prisma.$transaction(async (tx) => {
        if (!(await lockRouted(tx, claim.requestId, now))) throw new MovedOn();
        const withdrawn = await closeOpenQuotations(tx, { claimId: claim.id, status: "SENT" }, "WITHDRAWN", now);
        if (withdrawn !== 1) throw new MovedOn();
        const ended = await tx.clientRequestClaim.updateMany({
          where: { id: claim.id, outcome: null },
          data: { outcome: "RELEASED", endedAt: now, releaseReason: "OTHER", releaseNote: "Quote withdrawn" },
        });
        if (ended.count !== 1) throw new MovedOn();
        await afterClaimEnded(tx, claim.requestId, claim.lawyerId, now);
        return true;
      }),
    );
    return done === true;
  }
}
