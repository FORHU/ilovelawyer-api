import prisma from "../lib/prisma";
import { DecisionStatus, Prisma } from "@prisma/client";

export interface DecisionRecordCreateInput {
  sourceMessageId: string | null;
  anchor: string;
  payload: Prisma.InputJsonValue;
  authorUserId?: string | null;
}

export default class DecisionRecordRepo {
  static async create(caseId: string, data: DecisionRecordCreateInput) {
    return prisma.decisionRecord.create({ data: { caseId, ...data } });
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

  static async updateStatus(id: string, caseId: string, status: DecisionStatus, disputeNote?: string | null) {
    const existing = await prisma.decisionRecord.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    return prisma.decisionRecord.update({
      where: { id },
      data: { status, disputeNote: status === "DISPUTED" ? (disputeNote ?? null) : null },
    });
  }
}
