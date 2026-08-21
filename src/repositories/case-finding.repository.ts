import prisma from "../lib/prisma";
import { FindingCategory } from "@prisma/client";
import { AI_FINDING_NOTE } from "../constants/case-finding.constants";

export interface FindingInput {
  category: FindingCategory;
  label: string;
  notes?: string | null;
}

export default class CaseFindingRepo {
  static async list(caseId: string, category?: FindingCategory) {
    return prisma.caseFinding.findMany({
      where: { caseId, ...(category ? { category } : {}) },
      orderBy: { createdAt: "desc" },
    });
  }

  static async create(caseId: string, data: FindingInput) {
    return prisma.caseFinding.create({ data: { caseId, ...data } });
  }

  static async update(id: string, caseId: string, data: Partial<FindingInput>) {
    const existing = await prisma.caseFinding.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    return prisma.caseFinding.update({ where: { id }, data });
  }

  static async delete(id: string, caseId: string) {
    const result = await prisma.caseFinding.deleteMany({ where: { id, caseId } });
    return result.count > 0;
  }

  /** Replaces every AI-authored row (notes === AI_FINDING_NOTE) with a fresh AI-generated
   * batch, in one category at a time — mirrors ProceduralDeadlineRepo.replaceAiProcedureItems.
   * Manually-created findings are untouched. */
  static async replaceAiFindings(caseId: string, items: { category: FindingCategory; label: string }[]) {
    await prisma.$transaction(async (tx) => {
      await tx.caseFinding.deleteMany({ where: { caseId, notes: AI_FINDING_NOTE } });
      if (items.length === 0) return;
      await tx.caseFinding.createMany({
        data: items.map((item) => ({ caseId, category: item.category, label: item.label, notes: AI_FINDING_NOTE })),
      });
    });
    return this.list(caseId);
  }
}
