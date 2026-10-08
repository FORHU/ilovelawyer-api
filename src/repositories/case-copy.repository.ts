import prisma from "../lib/prisma";
import { CaseCopyStatus, ConsultationStatus, Prisma } from "@prisma/client";

type CarryOver = { sourceOrganizationId: string; sourceOrganizationName: string; userId: string; targetOrganizationId: string };

export default class CaseCopyRepo {
  /** Everything a member takes with them when they stop belonging to an organization, into their
   * portfolio (`targetOrganizationId`). Runs inside the caller's membership-change transaction, so
   * leaving and the carry-over commit together:
   * - every case they created is queued for a copy (enqueueForCreatorIn), which brings that case's
   *   consultations and calendar events along;
   * - every standalone consultation they started is queued for a copy (enqueueConsultationsIn);
   * - their own calendar — appointments and day notes — comes with them (carryCalendarIn). */
  static async carryOverIn(tx: Prisma.TransactionClient, input: CarryOver) {
    await CaseCopyRepo.enqueueForCreatorIn(tx, input);
    await CaseCopyRepo.enqueueConsultationsIn(tx, input);
    await CaseCopyRepo.carryCalendarIn(tx, input);
  }

  /** Queues a portfolio copy of every case `userId` created in the organization they're leaving
   * (archived ones too) — except a confidential one (#346): a walled matter stays with the firm.
   * Their grants and membership are already gone by now (see OrganizationMemberRepo.removeIn), so
   * whether they could still open it can't be told here; leaving it behind is the safe side.
   * Returns how many were queued. */
  static async enqueueForCreatorIn(tx: Prisma.TransactionClient, input: CarryOver) {
    const cases = await tx.case.findMany({
      where: { organizationId: input.sourceOrganizationId, userId: input.userId, confidential: false },
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

  /** Queues a portfolio copy of every standalone consultation (not on a case) `userId` started in
   * the organization they're leaving — archived ones too, not those already marked for deletion.
   * The organization keeps the originals: a consultation is shared with the whole organization.
   * Returns how many were queued. */
  static async enqueueConsultationsIn(tx: Prisma.TransactionClient, input: CarryOver) {
    const consultations = await tx.consultation.findMany({
      where: {
        organizationId: input.sourceOrganizationId,
        userId: input.userId,
        caseId: null,
        status: { not: ConsultationStatus.FOR_DELETION },
      },
      select: { id: true },
    });
    if (consultations.length === 0) return 0;
    await tx.consultationCopy.createMany({
      data: consultations.map((c) => ({
        sourceConsultationId: c.id,
        userId: input.userId,
        targetOrganizationId: input.targetOrganizationId,
      })),
    });
    return consultations.length;
  }

  /** A member's appointments and day notes are theirs — nobody else in the organization sees
   * them — so those not on a case move to the portfolio as they are, Google Calendar link and
   * reminders included. Appointments on a case are part of that case, which the organization
   * keeps: on a case they created, the case's copy brings them along; on anyone else's, they get
   * a copy here, unlinked from the case (no Google link or reminders, same as CaseCopySvc). */
  static async carryCalendarIn(tx: Prisma.TransactionClient, input: CarryOver) {
    const { sourceOrganizationId, userId, targetOrganizationId } = input;

    await tx.event.updateMany({
      where: { organizationId: sourceOrganizationId, userId, caseId: null },
      data: { organizationId: targetOrganizationId },
    });
    await tx.note.updateMany({
      where: { organizationId: sourceOrganizationId, userId },
      data: { organizationId: targetOrganizationId },
    });

    const onOthersCases = await tx.event.findMany({
      where: { organizationId: sourceOrganizationId, userId, caseId: { not: null }, NOT: { case: { is: { userId } } } },
    });
    if (onOthersCases.length === 0) return;

    // Leaving, rejoining and leaving again copies only what changed in between.
    const copies = await tx.event.findMany({
      where: { organizationId: targetOrganizationId, copiedFromId: { in: onOthersCases.map((e) => e.id) } },
      select: { copiedFromId: true, createdAt: true },
    });
    const copiedAt = new Map<string, Date>();
    for (const c of copies) {
      const seen = copiedAt.get(c.copiedFromId!);
      if (!seen || c.createdAt > seen) copiedAt.set(c.copiedFromId!, c.createdAt);
    }
    const toCopy = onOthersCases.filter((e) => !(copiedAt.get(e.id)! >= e.updatedAt));
    if (toCopy.length === 0) return;

    await tx.event.createMany({
      data: toCopy.map((e) => ({
        copiedFromId: e.id,
        userId,
        organizationId: targetOrganizationId,
        title: e.title,
        type: e.type,
        dateTime: e.dateTime,
        endDateTime: e.endDateTime,
        clientEmail: e.clientEmail,
        notes: e.notes,
        status: e.status,
        lawyerAcknowledgedAt: e.lawyerAcknowledgedAt,
        clientFeedback: e.clientFeedback,
        dateSource: e.dateSource,
      })),
    });
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

  // ── Standalone consultation copies: the same lifecycle as a case copy's, above ──────────────

  static async listPendingConsultationIds(take: number) {
    const rows = await prisma.consultationCopy.findMany({
      where: { status: CaseCopyStatus.PENDING },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take,
    });
    return rows.map((r) => r.id);
  }

  static async claimConsultation(id: string) {
    const { count } = await prisma.consultationCopy.updateMany({
      where: { id, status: CaseCopyStatus.PENDING },
      data: { status: CaseCopyStatus.RUNNING, attempts: { increment: 1 } },
    });
    return count === 1 ? prisma.consultationCopy.findUnique({ where: { id } }) : null;
  }

  static async markConsultationDone(id: string, copyConsultationId: string) {
    return prisma.consultationCopy.update({
      where: { id },
      data: { status: CaseCopyStatus.DONE, copyConsultationId, error: null },
    });
  }

  static async markConsultationFailed(id: string, error: string, retry: boolean) {
    return prisma.consultationCopy.update({
      where: { id },
      data: { status: retry ? CaseCopyStatus.PENDING : CaseCopyStatus.FAILED, error },
    });
  }

  /** A copy left RUNNING by a process that died mid-copy goes back in the queue. */
  static async requeueStale(olderThan: Date) {
    const where = { status: CaseCopyStatus.RUNNING, updatedAt: { lt: olderThan } };
    const data = { status: CaseCopyStatus.PENDING };
    const [cases, consultations] = await Promise.all([
      prisma.caseCopy.updateMany({ where, data }),
      prisma.consultationCopy.updateMany({ where, data }),
    ]);
    return cases.count + consultations.count;
  }
}
