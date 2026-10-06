import prisma from "../lib/prisma";
import { FindingCategory, FindingTag, Prisma } from "@prisma/client";
import { AI_FINDING_NOTE } from "../constants";
import { matchRegeneratedFindings } from "../utils/procedure-link";

export interface FindingInput {
  category: FindingCategory;
  label: string;
  notes?: string | null;
  sourceLabel?: string | null;
  detail?: string | null;
  tag?: FindingTag | null;
  position?: number | null;
  lawyerEditedAt?: Date | null;
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

  /** Stores an on-demand Jev check, and the impact number when the category has one. Leaves the
   * tag alone — Jev never overrides a pill the lawyer may have chosen; the panel shows its read
   * beside it instead. */
  static async setJevCheck(id: string, check: Prisma.InputJsonValue, impact?: number) {
    return prisma.caseFinding.update({
      where: { id },
      data: { jev: check, jevCheckedAt: new Date(), ...(impact !== undefined ? { impact } : {}) },
    });
  }

  static async delete(id: string, caseId: string) {
    const result = await prisma.caseFinding.deleteMany({ where: { id, caseId } });
    return result.count > 0;
  }

  /** Replaces every AI-authored row (notes === AI_FINDING_NOTE) with a fresh AI-generated
   * batch, in one category at a time — mirrors ProceduralDeadlineRepo.replaceAiProcedureItems.
   * Manually-created findings are untouched, and so are AI rows a lawyer has edited
   * (lawyerEditedAt) — an incoming row repeating one of those is dropped rather than duplicated. Each row's FINDING graph node is swapped in the same
   * transaction (CaseFindingSvc.create does this for manual rows via CaseGraphSvc.ensureNode) —
   * the Legal Issues panel reads the graph-view projection, which skips findings with no node. */
  static async replaceAiFindings(
    caseId: string,
    items: AiFindingRow[],
    /** Replace only this category's AI rows — one panel's Regenerate (CaseFindingAiSvc). */
    category?: FindingCategory,
  ) {
    const scope = category ? { category } : {};
    await prisma.$transaction(async (tx) => {
      const stale = await tx.caseFinding.findMany({
        where: { caseId, ...scope, notes: AI_FINDING_NOTE, lawyerEditedAt: null },
        select: { id: true, category: true, label: true },
      });
      const kept = await tx.caseFinding.findMany({
        where: { caseId, ...scope, notes: AI_FINDING_NOTE, lawyerEditedAt: { not: null } },
        select: { category: true, label: true },
      });
      const keptKeys = new Set(kept.map((f) => `${f.category}:${f.label.trim().toLowerCase()}`));
      const fresh = items.filter((item) => !keptKeys.has(`${item.category}:${item.label.trim().toLowerCase()}`));
      await tx.caseGraphNode.deleteMany({ where: { nodeType: "FINDING", refId: { in: stale.map((f) => f.id) } } });
      await tx.caseFinding.deleteMany({ where: { id: { in: stale.map((f) => f.id) } } });
      if (fresh.length === 0) return;
      const created = await tx.caseFinding.createManyAndReturn({
        data: fresh.map((item) => ({ ...item, caseId, notes: AI_FINDING_NOTE })),
        select: { id: true, category: true, label: true },
      });
      await tx.caseGraphNode.createMany({
        data: created.map((f) => ({ caseId, nodeType: "FINDING" as const, refId: f.id })),
        skipDuplicates: true,
      });
      // Case Strategy to-dos raised on a finding that came back follow it to its new id.
      for (const [from, to] of matchRegeneratedFindings(stale, created)) {
        await tx.procedureItem.updateMany({ where: { caseId, sourceKind: "FINDING", sourceId: from }, data: { sourceId: to } });
      }
    });
    return this.list(caseId);
  }
}
