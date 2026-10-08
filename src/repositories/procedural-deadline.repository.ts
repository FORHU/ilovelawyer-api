import prisma from "../lib/prisma";
import { AI_PROCEDURE_NOTE } from "../constants";
import { planAiProcedureItems } from "../utils/procedure-item-reconcile";
import type { ProcedureAutoCloseReason, ProcedureSourceKind } from "../utils/procedure-link";

export default class ProceduralDeadlineRepo {
  static async findProcedureItem(id: string, caseId: string) {
    return prisma.procedureItem.findFirst({ where: { id, caseId } });
  }

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

  static async createProcedureItem(
    caseId: string,
    data: {
      kind: string;
      label: string;
      notes?: string | null;
      sourceLabel?: string | null;
      sourceKind?: ProcedureSourceKind | null;
      sourceId?: string | null;
      sourceKey?: string | null;
      dueDate?: Date | null;
    },
  ) {
    return prisma.procedureItem.create({ data: { caseId, ...data } });
  }

  /** Moves the due date of every open to-do raised on this item. */
  static async setLinkedDueDate(caseId: string, sourceKind: ProcedureSourceKind, sourceId: string, dueDate: Date | null) {
    await prisma.procedureItem.updateMany({ where: { caseId, sourceKind, sourceId, done: false }, data: { dueDate } });
  }

  /** The open to-do already raised on this item, if any — "To checklist" is idempotent. */
  static async findOpenLinked(caseId: string, sourceKind: ProcedureSourceKind, sourceId: string, sourceKey: string | null) {
    return prisma.procedureItem.findFirst({ where: { caseId, sourceKind, sourceId, sourceKey, done: false } });
  }

  /** Ticks every open to-do raised on this item (or, with a key, on that witness need). */
  static async closeLinked(
    caseId: string,
    sourceKind: ProcedureSourceKind,
    sourceId: string,
    reason: ProcedureAutoCloseReason,
    sourceKeys?: string[],
  ) {
    const { count } = await prisma.procedureItem.updateMany({
      where: { caseId, sourceKind, sourceId, done: false, ...(sourceKeys ? { sourceKey: { in: sourceKeys } } : {}) },
      data: { done: true, autoClosedAt: new Date(), autoClosedReason: reason },
    });
    return count;
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

  /** Attaches Jev verdicts, but only to rows that still say exactly what Jev judged — a lawyer may
   * have edited the label while the check ran. Returns how many landed. */
  static async saveChecks(caseId: string, results: { id: string; label: string; check: object }[]) {
    let applied = 0;
    for (const r of results) {
      const { count } = await prisma.procedureItem.updateMany({ where: { id: r.id, caseId, label: r.label }, data: { check: r.check } });
      applied += count;
    }
    return applied;
  }

  static async updateProcedureItem(id: string, caseId: string, data: { done?: boolean; notes?: string | null; label?: string }) {
    const existing = await prisma.procedureItem.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    // Reopening a to-do its source ticked drops the "closed itself" note with it.
    const reopened = data.done === false ? { autoClosedAt: null, autoClosedReason: null } : {};
    return prisma.procedureItem.update({ where: { id }, data: { ...data, ...reopened } });
  }
}
