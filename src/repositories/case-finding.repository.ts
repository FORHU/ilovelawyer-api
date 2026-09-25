import prisma from "../lib/prisma";
import { FindingCategory, FindingTag, Prisma } from "@prisma/client";
import { AI_FINDING_NOTE } from "../constants";

export interface FindingInput {
  category: FindingCategory;
  label: string;
  notes?: string | null;
  sourceLabel?: string | null;
  detail?: string | null;
  tag?: FindingTag | null;
  position?: number | null;
}

/** One AI-generated row as replaceAiFindings stores it. The Jev fields are only set when a Jev
 * check ran and succeeded (see FindingJevSvc.verifyParsed). */
export interface AiFindingRow {
  category: FindingCategory;
  label: string;
  sourceLabel: string | null;
  detail?: string | null;
  tag?: FindingTag | null;
  impact?: number | null;
  position?: number | null;
  jev?: Prisma.InputJsonValue;
  modelTag?: FindingTag | null;
  modelImpact?: number | null;
  jevCheckedAt?: Date | null;
}

export default class CaseFindingRepo {
  static async list(caseId: string, category?: FindingCategory) {
    return prisma.caseFinding.findMany({
      where: { caseId, ...(category ? { category } : {}) },
      // Positioned rows first, in order; the rest newest first, as before position existed.
      orderBy: [{ position: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
    });
  }

  static async find(id: string, caseId: string) {
    return prisma.caseFinding.findFirst({ where: { id, caseId } });
  }

  static async create(caseId: string, data: FindingInput) {
    return prisma.caseFinding.create({ data: { caseId, ...data } });
  }

  static async update(id: string, caseId: string, data: Partial<FindingInput>) {
    const existing = await prisma.caseFinding.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    return prisma.caseFinding.update({ where: { id }, data });
  }

  /** Stores an on-demand Jev check. Leaves tag/impact alone — Jev never overrides a pill the
   * lawyer may have chosen; the panel shows its read beside it instead. */
  static async setJevCheck(id: string, check: Prisma.InputJsonValue) {
    return prisma.caseFinding.update({ where: { id }, data: { jev: check, jevCheckedAt: new Date() } });
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
    items: AiFindingRow[],
  ) {
    await prisma.$transaction(async (tx) => {
      await tx.caseFinding.deleteMany({ where: { caseId, notes: AI_FINDING_NOTE } });
      if (items.length === 0) return;
      await tx.caseFinding.createMany({
        data: items.map((item) => ({ ...item, caseId, notes: AI_FINDING_NOTE })),
      });
    });
    return this.list(caseId);
  }
}
