import prisma from "../lib/prisma";
import { FindingCategory, FindingReadiness } from "@prisma/client";
import { AI_FINDING_NOTE } from "../constants";

export interface FindingInput {
  category: FindingCategory;
  label: string;
  notes?: string | null;
  sourceLabel?: string | null;
  // ATTACK_STRATEGY/DEFENSE_STRATEGY only — lawyer-settable via PATCH. jevReadiness/jevConfidence
  // are AI-only (see replaceAiFindings) and deliberately not part of this lawyer-facing input.
  readiness?: FindingReadiness | null;
  readinessNote?: string | null;
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
  static async replaceAiFindings(
    caseId: string,
    items: {
      category: FindingCategory;
      label: string;
      sourceLabel: string | null;
      readiness?: FindingReadiness | null;
      readinessNote?: string | null;
      jevReadiness?: FindingReadiness | null;
      jevConfidence?: number | null;
    }[],
  ) {
    await prisma.$transaction(async (tx) => {
      await tx.caseFinding.deleteMany({ where: { caseId, notes: AI_FINDING_NOTE } });
      if (items.length === 0) return;
      await tx.caseFinding.createMany({
        data: items.map((item) => ({
          caseId,
          category: item.category,
          label: item.label,
          sourceLabel: item.sourceLabel,
          readiness: item.readiness ?? null,
          readinessNote: item.readinessNote ?? null,
          jevReadiness: item.jevReadiness ?? null,
          jevConfidence: item.jevConfidence ?? null,
          notes: AI_FINDING_NOTE,
        })),
      });
    });
    return this.list(caseId);
  }
}
