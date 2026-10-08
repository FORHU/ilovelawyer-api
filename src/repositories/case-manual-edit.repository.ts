import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { ManualEditChange, ManualEditEntry } from "../types/manual-edit";

const WITH_ACTOR = { actor: { select: { id: true, name: true, username: true } } } as const;

// Append-only, except ManualEditLog's same-field collapse (updateChanges / remove).
export default class CaseManualEditRepo {
  static async create(caseId: string, actorId: string | null, entry: ManualEditEntry) {
    return prisma.caseManualEdit.create({
      data: {
        caseId,
        actorId,
        pane: entry.pane,
        kind: entry.kind,
        itemId: entry.itemId ?? null,
        action: entry.action,
        label: entry.label,
        changes: entry.changes ? (entry.changes as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      },
    });
  }

  /** The same person's latest "edited" row for this item and kind since `since` — what a new edit
   * of the same field collapses into. */
  static async findRecentEdit(caseId: string, actorId: string, kind: string, itemId: string, since: Date) {
    return prisma.caseManualEdit.findFirst({
      where: { caseId, actorId, kind, itemId, action: "edited", createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
    });
  }

  static async updateChanges(id: string, label: string, changes: ManualEditChange[]) {
    return prisma.caseManualEdit.update({ where: { id }, data: { label, changes: changes as unknown as Prisma.InputJsonValue } });
  }

  static async remove(id: string) {
    await prisma.caseManualEdit.delete({ where: { id } });
  }

  /** Edits made in [from, to), oldest first, with who made them. */
  static async listBetween(caseId: string, from: Date | null, to: Date) {
    return prisma.caseManualEdit.findMany({
      where: { caseId, createdAt: { ...(from ? { gt: from } : {}), lt: to } },
      orderBy: { createdAt: "asc" },
      include: WITH_ACTOR,
    });
  }

  /** Every edit's author and time — enough to count editing sessions per day. */
  static async listTimes(caseId: string) {
    return prisma.caseManualEdit.findMany({
      where: { caseId },
      orderBy: { createdAt: "asc" },
      select: { id: true, actorId: true, createdAt: true },
    });
  }
}
