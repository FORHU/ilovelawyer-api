import prisma from "../lib/prisma";
import { RiskSeverity, RiskStatus } from "@prisma/client";

export interface RiskInput {
  title: string;
  description?: string | null;
  severity: RiskSeverity;
  status?: RiskStatus;
  ownerUserId?: string | null;
  documentId?: string | null;
  chunkId?: string | null;
  pageNumber?: number | null;
}

export default class CaseRiskRepo {
  static async list(caseId: string) {
    return prisma.caseRisk.findMany({
      where: { caseId },
      orderBy: { createdAt: "desc" },
    });
  }

  static async create(caseId: string, data: RiskInput) {
    return prisma.caseRisk.create({ data: { caseId, ...data } });
  }

  static async update(id: string, caseId: string, data: Partial<RiskInput>) {
    const existing = await prisma.caseRisk.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    return prisma.caseRisk.update({ where: { id }, data });
  }

  static async delete(id: string, caseId: string) {
    const result = await prisma.caseRisk.deleteMany({ where: { id, caseId } });
    return result.count > 0;
  }

  static async countWithSource(caseId?: string) {
    return prisma.caseRisk.count({
      where: {
        ...(caseId ? { caseId } : {}),
        documentId: { not: null },
      },
    });
  }

  static async countAll(caseId?: string) {
    return prisma.caseRisk.count({ where: caseId ? { caseId } : {} });
  }
}
