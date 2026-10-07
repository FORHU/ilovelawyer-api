import prisma from "../lib/prisma";
import { CaseCopyStatus, Prisma } from "@prisma/client";

export default class CaseCopyRepo {
  /** Queues a portfolio copy of every case `userId` created in the organization they're leaving
   * (archived ones too). Runs inside the caller's membership-change transaction, so leaving and
   * the promise of copies commit together. Returns how many were queued. */
  static async enqueueForCreatorIn(
    tx: Prisma.TransactionClient,
    input: { sourceOrganizationId: string; sourceOrganizationName: string; userId: string; targetOrganizationId: string },
  ) {
    const cases = await tx.case.findMany({
      where: { organizationId: input.sourceOrganizationId, userId: input.userId },
      select: { id: true, caseName: true },
    });
    if (cases.length === 0) return 0;
    await tx.caseCopy.createMany({
      data: cases.map((c) => ({
        sourceCaseId: c.id,
        caseName: c.caseName,
        sourceOrganizationName: input.sourceOrganizationName,
        userId: input.userId,
        targetOrganizationId: input.targetOrganizationId,
      })),
    });
    return cases.length;
  }

  /** Copies the portfolio still shows as in progress or failed (finished ones are real cases). */
  static async listUnfinishedForUser(userId: string, targetOrganizationId: string) {
    return prisma.caseCopy.findMany({
      where: { userId, targetOrganizationId, status: { not: CaseCopyStatus.DONE } },
      select: { id: true, sourceCaseId: true, caseName: true, sourceOrganizationName: true, status: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
  }

  static async listPendingIds(take: number) {
    const rows = await prisma.caseCopy.findMany({
      where: { status: CaseCopyStatus.PENDING },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take,
    });
    return rows.map((r) => r.id);
  }

  /** Atomically takes a PENDING copy, so two API instances never work on the same one. */
  static async claim(id: string) {
    const { count } = await prisma.caseCopy.updateMany({
      where: { id, status: CaseCopyStatus.PENDING },
      data: { status: CaseCopyStatus.RUNNING, attempts: { increment: 1 } },
    });
    return count === 1 ? prisma.caseCopy.findUnique({ where: { id } }) : null;
  }

  static async markDone(id: string, copyCaseId: string) {
    return prisma.caseCopy.update({ where: { id }, data: { status: CaseCopyStatus.DONE, copyCaseId, error: null } });
  }

  static async markFailed(id: string, error: string, retry: boolean) {
    return prisma.caseCopy.update({
      where: { id },
      data: { status: retry ? CaseCopyStatus.PENDING : CaseCopyStatus.FAILED, error },
    });
  }

  /** A copy left RUNNING by a process that died mid-copy goes back in the queue. */
  static async requeueStale(olderThan: Date) {
    const { count } = await prisma.caseCopy.updateMany({
      where: { status: CaseCopyStatus.RUNNING, updatedAt: { lt: olderThan } },
      data: { status: CaseCopyStatus.PENDING },
    });
    return count;
  }
}
