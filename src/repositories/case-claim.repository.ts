import prisma from "../lib/prisma";

export interface CaseClaimInput {
  title: string;
  causeOfAction?: string | null;
  description?: string | null;
}

export default class CaseClaimRepo {
  static async list(caseId: string) {
    return prisma.caseClaim.findMany({ where: { caseId }, orderBy: { createdAt: "desc" } });
  }

  static async create(caseId: string, data: CaseClaimInput) {
    return prisma.caseClaim.create({ data: { caseId, ...data } });
  }

  static async update(id: string, caseId: string, data: Partial<CaseClaimInput>) {
    const existing = await prisma.caseClaim.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    return prisma.caseClaim.update({ where: { id }, data });
  }

  static async delete(id: string, caseId: string) {
    const result = await prisma.caseClaim.deleteMany({ where: { id, caseId } });
    return result.count > 0;
  }
}
