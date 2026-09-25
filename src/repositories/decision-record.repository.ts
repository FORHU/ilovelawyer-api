import prisma from "../lib/prisma";
import { DecisionStatus, Prisma } from "@prisma/client";
import CaseRepo from "./case.repository";

export interface DecisionRecordCreateInput {
  sourceMessageId: string | null;
  anchor: string;
  payload: Prisma.InputJsonValue;
  authorUserId?: string | null;
}

export default class DecisionRecordRepo {
  static async create(caseId: string, data: DecisionRecordCreateInput) {
    const created = await prisma.decisionRecord.create({ data: { caseId, ...data } });
    CaseRepo.touchSafe(caseId);
    return created;
  }

  static async list(caseId: string, status?: DecisionStatus) {
    return prisma.decisionRecord.findMany({
      where: { caseId, ...(status ? { status } : {}) },
      orderBy: { createdAt: "desc" },
    });
  }

  static async findById(id: string, caseId: string) {
    return prisma.decisionRecord.findFirst({ where: { id, caseId } });
  }

  /** Idempotency guard for CaseGraphPromotionQueue: DecisionRecordSvc.promote() has no
   * dedup of its own (each call is meant to add new records for a turn), so a retried/
   * redelivered promotion job for the same assistant message must check this first rather
   * than call promote() again and double the case's decision records. */
  static async existsForSourceMessage(sourceMessageId: string): Promise<boolean> {
    const row = await prisma.decisionRecord.findFirst({ where: { sourceMessageId }, select: { id: true } });
    return row !== null;
  }

  static async updateStatus(id: string, caseId: string, status: DecisionStatus, disputeNote?: string | null) {
    const existing = await prisma.decisionRecord.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    return prisma.decisionRecord.update({
      where: { id },
      data: { status, disputeNote: status === "DISPUTED" ? (disputeNote ?? null) : null },
    });
  }
}
