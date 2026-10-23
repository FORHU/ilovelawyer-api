import { OrganizationChargeKind, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import type { CardChargeResult } from "../payments/organization-card-provider";

/** Rolls a transaction back when the request or charge had already moved on. */
class MovedOn extends Error {}

/**
 * Charges to a law firm's card on file (OrganizationCharge). Every transaction that also changes the
 * request updates the request row first, then the charge, then the claim (REQUEST_ROW_FIRST in
 * client-request-claim.repository.ts), so none of them can deadlock with a claim, quote, release,
 * lapse or withdrawal at the same moment.
 */
export default class OrganizationChargeRepo {
  /**
   * The client confirms (#513): QUOTED -> CONFIRMED, and the per-case fee is recorded PENDING against
   * the organization whose lawyer quoted. Both or neither, once: null when the request isn't QUOTED
   * any more (a second confirm, a decline, a withdrawal, the lawyer released it).
   */
  static async confirm(requestId: string, fee: { amountMinor: number; currency: string }) {
    try {
      return await prisma.$transaction(async (tx) => {
        const { count } = await tx.clientRequest.updateMany({ where: { id: requestId, status: "QUOTED" }, data: { status: "CONFIRMED" } });
        if (count !== 1) throw new MovedOn();
        const claim = await tx.clientRequestClaim.findFirst({ where: { requestId, outcome: null, quotedAt: { not: null } } });
        if (!claim) throw new MovedOn();
        const charge = await tx.organizationCharge.create({
          data: {
            organizationId: claim.organizationId,
            kind: "PER_CASE_FEE",
            status: "PENDING",
            amountMinor: fee.amountMinor,
            currency: fee.currency,
            requestId,
            feeRequestId: requestId,
            lawyerId: claim.lawyerId,
          },
        });
        return { charge, claim };
      });
    } catch (err) {
      if (err instanceof MovedOn) return null;
      throw err;
    }
  }

  static async findById(id: string) {
    return prisma.organizationCharge.findUnique({ where: { id } });
  }

  static async findFeeForRequest(requestId: string) {
    return prisma.organizationCharge.findUnique({ where: { feeRequestId: requestId } });
  }

  static async findByPaymentIntent(paymentIntentId: string) {
    return prisma.organizationCharge.findFirst({ where: { paymentIntentId } });
  }

  /**
   * Starts an attempt: a fresh charge (PENDING, never tried) or a FAILED one moves to PENDING with
   * the attempt counted. Two retries at once both try the update; only one matches. Returns the
   * attempt number, or null when another attempt is running or it already succeeded.
   */
  static async startAttempt(id: string, provider: string): Promise<number | null> {
    const { count } = await prisma.organizationCharge.updateMany({
      where: { id, OR: [{ status: "FAILED" }, { status: "PENDING", attempts: 0 }] },
      data: { status: "PENDING", attempts: { increment: 1 }, provider, failureReason: null },
    });
    if (count !== 1) return null;
    return (await prisma.organizationCharge.findUniqueOrThrow({ where: { id }, select: { attempts: true } })).attempts;
  }

  /** An attempt that couldn't reach the provider at all (no card on file): FAILED, the attempt counted. */
  static async failWithoutAttempt(id: string, reason: string) {
    await prisma.organizationCharge.updateMany({
      where: { id, OR: [{ status: "FAILED" }, { status: "PENDING", attempts: 0 }] },
      data: { status: "FAILED", attempts: { increment: 1 }, failureReason: reason, provider: null },
    });
  }

  /**
   * An attempt that got no answer (the provider was unreachable or timed out): FAILED, but the attempt
   * isn't counted. The retry then reuses the same attempt number, so the same idempotency key: if the
   * first one did reach Stripe, Stripe answers with that payment instead of charging again.
   */
  static async abandonAttempt(id: string, attempt: number, reason: string) {
    await prisma.organizationCharge.updateMany({
      where: { id, attempts: attempt, status: "PENDING" },
      data: { status: "FAILED", attempts: { decrement: 1 }, failureReason: reason },
    });
  }

  /** Records the provider's payment for an attempt still PENDING (so its webhook can find it). */
  static async setPaymentIntent(id: string, attempt: number, paymentIntentId: string | null) {
    if (!paymentIntentId) return;
    await prisma.organizationCharge.updateMany({ where: { id, attempts: attempt, status: "PENDING" }, data: { paymentIntentId } });
  }

  /**
   * Ends an attempt, once: only while the charge still matches `when`, so the provider's answer and its
   * webhook can't both apply it. The direct answer settles its own PENDING attempt; the webhook settles
   * by payment, and records a success even on a charge we'd marked FAILED (the money was taken). A
   * per-case fee that went through also engages the request: CONFIRMED -> ENGAGED and the claim ends
   * ENGAGED, in the same transaction. Returns whether this call settled it, and whether it engaged.
   */
  static async settle(
    id: string,
    when: Prisma.OrganizationChargeWhereInput,
    result: CardChargeResult,
    now: Date = new Date(),
  ): Promise<{ settled: boolean; engaged: boolean }> {
    const charge = await prisma.organizationCharge.findUnique({ where: { id }, select: { kind: true, requestId: true } });
    if (!charge || result.status === "PENDING") return { settled: false, engaged: false };
    const succeeded = result.status === "SUCCEEDED";
    const engages = succeeded && charge.kind === OrganizationChargeKind.PER_CASE_FEE && !!charge.requestId;
    try {
      return await prisma.$transaction(async (tx) => {
        // Request row first. Money taken is recorded even if the request somehow moved on.
        const engaged = engages
          ? (await tx.clientRequest.updateMany({ where: { id: charge.requestId!, status: "CONFIRMED" }, data: { status: "ENGAGED", engagedAt: now } })).count === 1
          : false;
        const { count } = await tx.organizationCharge.updateMany({
          where: { AND: [{ id }, when] },
          data: {
            status: succeeded ? "SUCCEEDED" : "FAILED",
            ...(result.paymentIntentId ? { paymentIntentId: result.paymentIntentId } : {}),
            receiptUrl: result.receiptUrl,
            failureReason: result.failureReason,
            succeededAt: succeeded ? now : null,
          },
        });
        if (count !== 1) throw new MovedOn();
        if (engaged) {
          await tx.clientRequestClaim.updateMany({ where: { requestId: charge.requestId!, outcome: null }, data: { outcome: "ENGAGED", openRequestId: null } });
        }
        return { settled: true, engaged };
      });
    } catch (err) {
      if (err instanceof MovedOn) return { settled: false, engaged: false };
      throw err;
    }
  }

  /** The organization's charges, newest first, with the lawyer each is for. */
  static async listForOrganization(organizationId: string, kind: OrganizationChargeKind | undefined, page: number, limit: number) {
    return OrganizationChargeRepo.list({ organizationId, ...(kind ? { kind } : {}) }, page, limit);
  }

  /** A solo lawyer's own charges: theirs, with no organization (docs/adr/0022). */
  static async listForLawyer(lawyerId: string, kind: OrganizationChargeKind | undefined, page: number, limit: number) {
    return OrganizationChargeRepo.list({ organizationId: null, lawyerId, ...(kind ? { kind } : {}) }, page, limit);
  }

  private static async list(where: Prisma.OrganizationChargeWhereInput, page: number, limit: number) {
    const [total, data] = await prisma.$transaction([
      prisma.organizationCharge.count({ where }),
      prisma.organizationCharge.findMany({
        where,
        include: { refunds: { orderBy: { createdAt: "desc" } } },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return { total, data };
  }

  static async findUserNames(ids: string[]) {
    if (!ids.length) return [];
    return prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } });
  }

  /** Who to tell when the card is declined: the organization's OWNERs and ADMINs, who can change it. */
  static async findBillingAdmins(organizationId: string): Promise<string[]> {
    const rows = await prisma.organizationMember.findMany({
      where: { organizationId, status: "ACCEPTED", role: { in: ["OWNER", "ADMIN"] } },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }
}
