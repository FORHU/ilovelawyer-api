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
  static async create(data: NewClientPayment) {
    return prisma.clientPayment.create({ data });
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

  /** Whether the client has ever paid for a case (for first-case-only promos). */
  static async hasPaidForCase(userId: string): Promise<boolean> {
    return (await prisma.clientPayment.count({ where: { userId, kind: "CASE", status: "SUCCEEDED" } })) > 0;
  }

  /** Marks a successful case payment as used, once: the update only matches while it's unused, so
   * two requests with the same payment can't both create a case. Returns its credits, or null when
   * it's not this client's, didn't succeed, or was already used. */
  static async claimCasePayment(paymentId: string, userId: string): Promise<number | null> {
    const { count } = await prisma.clientPayment.updateMany({
      where: { id: paymentId, userId, kind: "CASE", status: "SUCCEEDED", usedAt: null },
      data: { usedAt: new Date() },
    });
    if (count !== 1) return null;
    const row = await prisma.clientPayment.findUnique({ where: { id: paymentId }, select: { credits: true } });
    return row?.credits ?? null;
  }

  /** Gives back a claimed payment whose case couldn't be created, so the client can try again. */
  static async releaseCasePayment(paymentId: string): Promise<void> {
    await prisma.clientPayment.updateMany({ where: { id: paymentId, caseId: null }, data: { usedAt: null } });
  }

  /** Ties a claimed payment to the case it paid for, and gives the case its credits. */
  static async attachToCase(paymentId: string, caseId: string, credits: number): Promise<void> {
    await prisma.$transaction([
      prisma.clientPayment.update({ where: { id: paymentId }, data: { caseId } }),
      prisma.case.update({ where: { id: caseId }, data: { clientCredits: credits } }),
    ]);
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
