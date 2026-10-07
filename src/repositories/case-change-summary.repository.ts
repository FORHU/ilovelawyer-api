import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { CaseChangeDeltas, CaseChangeReason, ChangedDocument } from "../types/case-change";

export interface CaseChangeSummaryInput {
  id: string;
  caseId: string;
  reason: CaseChangeReason;
  actorId: string | null;
  readyDocumentIds: string[];
  documentsAdded: ChangedDocument[];
  documentsRemoved: ChangedDocument[];
  totalChanges: number;
  firstAnalysis: boolean;
  perPaneDeltas: CaseChangeDeltas;
}

// Written once per refresh, never updated — see the CaseChangeSummary schema comment.
export default class CaseChangeSummaryRepo {
  static async create(data: CaseChangeSummaryInput) {
    return prisma.caseChangeSummary.create({
      data: {
        ...data,
        documentsAdded: data.documentsAdded as unknown as Prisma.InputJsonValue,
        documentsRemoved: data.documentsRemoved as unknown as Prisma.InputJsonValue,
        perPaneDeltas: data.perPaneDeltas as unknown as Prisma.InputJsonValue,
      },
    });
  }

  static async latest(caseId: string) {
    return prisma.caseChangeSummary.findFirst({ where: { caseId }, orderBy: { createdAt: "desc" } });
  }

  /** The latest summary of a whole-case refresh (not a pane's Regenerate) — the baseline for
   * which documents are new. */
  static async latestRefresh(caseId: string) {
    return prisma.caseChangeSummary.findFirst({
      where: { caseId, reason: { in: ["manual", "post-extraction"] } },
      orderBy: { createdAt: "desc" },
    });
  }

  static async list(caseId: string, limit: number) {
    return prisma.caseChangeSummary.findMany({ where: { caseId }, orderBy: { createdAt: "desc" }, take: limit });
  }
}
