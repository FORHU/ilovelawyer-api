import prisma from "../lib/prisma";
import { AI_PROCEDURE_NOTE } from "../constants";
import { planAiProcedureItems } from "../utils/procedure-item-reconcile";

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

  static async updateComputed(
    id: string,
    data: { triggerDate: Date; computedDueDate: Date; calculationNotes: string },
  ) {
    return prisma.proceduralDeadline.update({ where: { id }, data });
  }

  static async clearConfirmations(deadlineId: string) {
    return prisma.proceduralDeadlineConfirmation.deleteMany({ where: { deadlineId } });
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

  /** Reconciles rather than replaces — see planAiProcedureItems: ticked items survive a refresh. */
  static async replaceAiProcedureItems(
    caseId: string,
    items: { kind: string; label: string; sourceLabel: string | null }[],
  ) {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.procedureItem.findMany({
        where: { caseId, notes: AI_PROCEDURE_NOTE },
        select: { id: true, kind: true, label: true, done: true, sourceLabel: true },
      });
      const plan = planAiProcedureItems(existing, items);
      if (plan.remove.length) await tx.procedureItem.deleteMany({ where: { caseId, id: { in: plan.remove } } });
      for (const row of plan.update) {
        await tx.procedureItem.update({ where: { id: row.id }, data: { sourceLabel: row.sourceLabel } });
      }
      if (plan.create.length) {
        await tx.procedureItem.createMany({
          data: plan.create.map((item) => ({
            caseId,
            kind: item.kind,
            label: item.label,
            sourceLabel: item.sourceLabel,
            notes: AI_PROCEDURE_NOTE,
          })),
        });
      }
    });
    return this.listProcedureItems(caseId);
  }

  static async updateProcedureItem(id: string, caseId: string, data: { done?: boolean; notes?: string | null; label?: string }) {
    const existing = await prisma.procedureItem.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    return prisma.procedureItem.update({ where: { id }, data });
  }
}
