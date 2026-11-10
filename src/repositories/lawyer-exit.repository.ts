import type { LawyerExit, LawyerExitStatus, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

/** A Lawyer Exit that isn't settled yet: what the admin queue shows, and what holds the earning back. */
export const OPEN_LAWYER_EXIT_STATUSES: LawyerExitStatus[] = ["REFUNDING", "AWAITING_REVIEW", "WAITING_ON_DISPUTE", "NEEDS_ATTENTION"];

/** Where an admin can decide the refund: the lawyer claimed work done, or a refund failed. */
export const DECIDABLE_LAWYER_EXIT_STATUSES: LawyerExitStatus[] = ["AWAITING_REVIEW", "NEEDS_ATTENTION"];

/**
 * Lawyer Exits (LawyerExit): a lawyer ending a paid engagement because they can't continue, and where
 * its refund stands. Every change of status is a guarded update (`move`), so a webhook, a sweep and
 * an admin acting at once can't both move the same exit.
 */
export default class LawyerExitRepo {
  static async findById(id: string) {
    return prisma.lawyerExit.findUnique({ where: { id } });
  }

  static async findByRequest(requestId: string) {
    return prisma.lawyerExit.findUnique({ where: { requestId } });
  }

  static async findByRequests(requestIds: string[]): Promise<Map<string, LawyerExit>> {
    if (!requestIds.length) return new Map();
    const rows = await prisma.lawyerExit.findMany({ where: { requestId: { in: requestIds } } });
    return new Map(rows.map((r) => [r.requestId, r]));
  }

  static async findByPayments(paymentIds: string[]): Promise<Map<string, LawyerExit>> {
    if (!paymentIds.length) return new Map();
    const rows = await prisma.lawyerExit.findMany({ where: { paymentId: { in: paymentIds } } });
    return new Map(rows.map((r) => [r.paymentId!, r]));
  }

  /** The exit whose refund this is, while it's on its way. */
  static async findByRefund(refundId: string) {
    return prisma.lawyerExit.findFirst({ where: { refundId, status: "REFUNDING" } });
  }

  /** Exits on a payment in one of `statuses`. */
  static async findForPayment(paymentId: string, statuses: LawyerExitStatus[]) {
    return prisma.lawyerExit.findMany({ where: { paymentId, status: { in: statuses } } });
  }

  /** Every lawyer who stopped acting on this case: not offered a new request on it again. */
  static async lawyerIdsForCase(caseId: string): Promise<string[]> {
    const rows = await prisma.lawyerExit.findMany({ where: { caseId }, select: { lawyerId: true }, distinct: ["lawyerId"] });
    return rows.map((r) => r.lawyerId);
  }

  /** Moves the exit on only while it's still in one of `from`. True when this call moved it. */
  static async move(id: string, from: LawyerExitStatus[], data: Prisma.LawyerExitUpdateManyMutationInput): Promise<boolean> {
    const { count } = await prisma.lawyerExit.updateMany({ where: { id, status: { in: from } }, data });
    return count === 1;
  }

  /** The admin queue, newest first. */
  static async list(where: Prisma.LawyerExitWhereInput, page: number, limit: number) {
    const [total, data] = await prisma.$transaction([
      prisma.lawyerExit.count({ where }),
      prisma.lawyerExit.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * limit, take: limit }),
    ]);
    return { total, data };
  }
}
