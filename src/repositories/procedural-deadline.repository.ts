import prisma from "../lib/prisma";
import { AI_PROCEDURE_NOTE } from "../constants/case-strategy.constants";

export default class ProceduralDeadlineRepo {
  static async list(caseId: string) {
    return prisma.proceduralDeadline.findMany({
      where: { caseId },
      include: { confirmations: true },
      orderBy: { computedDueDate: "asc" },
    });
  }

  static async create(
    caseId: string,
    data: {
      label: string;
      ruleCode: string;
      triggerDate: Date;
      computedDueDate: Date;
      ruleSource: string;
      serviceMethod?: string | null;
      calculationNotes: string;
    },
  ) {
    return prisma.proceduralDeadline.create({ data: { caseId, ...data }, include: { confirmations: true } });
  }

  static async findById(id: string, caseId: string) {
    return prisma.proceduralDeadline.findFirst({
      where: { id, caseId },
      include: { confirmations: true },
    });
  }

  static async confirm(deadlineId: string, userId: string, confirmed: boolean, note?: string) {
    return prisma.proceduralDeadlineConfirmation.upsert({
      where: { deadlineId_userId: { deadlineId, userId } },
      create: { deadlineId, userId, confirmed, note },
      update: { confirmed, note },
    });
  }

  static async listProcedureItems(caseId: string) {
    return prisma.procedureItem.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } });
  }

  static async createProcedureItem(caseId: string, data: { kind: string; label: string; notes?: string | null }) {
    return prisma.procedureItem.create({ data: { caseId, ...data } });
  }

  static async replaceAiProcedureItems(caseId: string, items: { kind: string; label: string }[]) {
    await prisma.$transaction(async (tx) => {
      await tx.procedureItem.deleteMany({ where: { caseId, notes: AI_PROCEDURE_NOTE } });
      if (items.length === 0) return;
      await tx.procedureItem.createMany({
        data: items.map((item) => ({ caseId, kind: item.kind, label: item.label, notes: AI_PROCEDURE_NOTE })),
      });
    });
    return this.listProcedureItems(caseId);
  }

  static async updateProcedureItem(id: string, caseId: string, data: { done?: boolean; notes?: string | null; label?: string }) {
    const existing = await prisma.procedureItem.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    return prisma.procedureItem.update({ where: { id }, data });
  }
}
