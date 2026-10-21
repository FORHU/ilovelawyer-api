import { ClientPaymentKind, ClientPaymentStatus } from "@prisma/client";
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

  /** Takes one credit if there is one; false when the case has none left. */
  static async spendCredit(caseId: string): Promise<boolean> {
    const { count } = await prisma.case.updateMany({ where: { id: caseId, clientCredits: { gt: 0 } }, data: { clientCredits: { decrement: 1 } } });
    return count === 1;
  }
}
