import prisma from "../lib/prisma";

export interface WitnessInput {
  name: string;
  role?: string | null;
  contact?: string | null;
  notes?: string | null;
}

export default class WitnessRepo {
  static async list(caseId: string) {
    return prisma.witness.findMany({ where: { caseId }, orderBy: { createdAt: "desc" } });
  }

  static async create(caseId: string, data: WitnessInput) {
    return prisma.witness.create({ data: { caseId, ...data } });
  }

  static async update(id: string, caseId: string, data: Partial<WitnessInput>) {
    const existing = await prisma.witness.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    return prisma.witness.update({ where: { id }, data });
  }

  static async delete(id: string, caseId: string) {
    const result = await prisma.witness.deleteMany({ where: { id, caseId } });
    return result.count > 0;
  }
}
