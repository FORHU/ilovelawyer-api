import { ClientPaymentKind, ClientPaymentStatus, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

export interface NewClientPayment {
  userId: string;
  caseId: string | null;
  kind: ClientPaymentKind;
  provider: string;
  externalId: string | null;
  amountMinor: number;
  currency: string;
  credits: number;
  promoCode: string | null;
  status: ClientPaymentStatus;
  failureReason: string | null;
}

export default class ClientPaymentRepo {
  /** A top-up that's already paid (the dummy, or FREE) adds its credits to the case in the same
   * transaction, as settle() does for one that settles later, so a paid top-up is never left
   * without its credits. */
  static async create(data: NewClientPayment) {
    if (data.status !== "SUCCEEDED" || data.kind !== "TOP_UP" || !data.caseId) return prisma.clientPayment.create({ data });
    const caseId = data.caseId;
    return prisma.$transaction(async (tx) => {
      const payment = await tx.clientPayment.create({ data });
      await tx.case.update({ where: { id: caseId }, data: { clientCredits: { increment: data.credits } } });
      return payment;
    });
  }

  static async setExternalId(id: string, externalId: string) {
    await prisma.clientPayment.update({ where: { id }, data: { externalId } });
  }

  /** Only the client's own. */
  static async findForUser(id: string, userId: string) {
    return prisma.clientPayment.findFirst({ where: { id, userId } });
  }

  static async findById(id: string) {
    return prisma.clientPayment.findUnique({ where: { id } });
  }

  static async findEmail(userId: string): Promise<string | null> {
    return (await prisma.user.findUnique({ where: { id: userId }, select: { email: true } }))?.email ?? null;
  }

  /**
   * Settles a PENDING payment, once: the update only matches while it's still PENDING, so a webhook
   * and the app asking at the same moment can't both apply it. A paid top-up adds its credits to the
   * case in the same transaction. Returns whether this call settled it.
   */
  static async settle(id: string, outcome: { paid: true } | { paid: false; reason: string }): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.clientPayment.updateMany({
        where: { id, status: "PENDING" },
        data: outcome.paid ? { status: "SUCCEEDED" } : { status: "FAILED", failureReason: outcome.reason },
      });
      if (count !== 1) return false;
      if (outcome.paid) {
        const payment = await tx.clientPayment.findUniqueOrThrow({ where: { id }, select: { kind: true, caseId: true, credits: true } });
        if (payment.kind === "TOP_UP" && payment.caseId) {
          await tx.case.update({ where: { id: payment.caseId }, data: { clientCredits: { increment: payment.credits } } });
        }
      }
      return true;
    });
  }

  /** Records a Stripe webhook event as handled. False when it already was (a retried delivery). */
  static async recordWebhookEvent(id: string, type: string): Promise<boolean> {
    try {
      await prisma.stripeWebhookEvent.create({ data: { id, type } });
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
      throw err;
    }
  }

  static async isWebhookEventRecorded(id: string): Promise<boolean> {
    return (await prisma.stripeWebhookEvent.count({ where: { id } })) > 0;
  }

  /** Whether the client has ever bought a top-up (for first-top-up-only promos). */
  static async hasPaidTopUp(userId: string): Promise<boolean> {
    return (await prisma.clientPayment.count({ where: { userId, kind: "TOP_UP", status: "SUCCEEDED" } })) > 0;
  }

  /** Payments that used a tenant's promo code, paid or still at checkout (so a code with one use
   * left can't be taken twice at once): top-ups, and the case payments promos applied to before
   * cases were free. Codes are per tenant, so the payer's tenant is matched too. With `userId`,
   * only that client's. */
  static async countPromoRedemptions(tenantId: string, promoCode: string, userId?: string): Promise<number> {
    return prisma.clientPayment.count({
      where: { promoCode, status: { in: ["SUCCEEDED", "PENDING"] }, user: { tenantId }, ...(userId ? { userId } : {}) },
    });
  }

  /** The client's tenant: whose prices and promo codes apply to them. */
  static async findTenantId(userId: string): Promise<string | null> {
    return (await prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true } }))?.tenantId ?? null;
  }

  /** Returns the case's new balance. */
  static async addCredits(caseId: string, credits: number): Promise<number> {
    const row = await prisma.case.update({ where: { id: caseId }, data: { clientCredits: { increment: credits } }, select: { clientCredits: true } });
    return row.clientCredits;
  }

  static async creditsOf(caseId: string): Promise<number> {
    return (await prisma.case.findUnique({ where: { id: caseId }, select: { clientCredits: true } }))?.clientCredits ?? 0;
  }

  /** Takes one credit if there is one; false when the case has none left. */
  static async spendCredit(caseId: string): Promise<boolean> {
    const { count } = await prisma.case.updateMany({ where: { id: caseId, clientCredits: { gt: 0 } }, data: { clientCredits: { decrement: 1 } } });
    return count === 1;
  }
}
