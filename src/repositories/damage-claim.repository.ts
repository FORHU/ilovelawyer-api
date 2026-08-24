import prisma from "../lib/prisma";
import { DamageCategory } from "@prisma/client";

export interface DamageClaimInput {
  category: DamageCategory;
  description?: string | null;
  amount?: number | null;
}

export default class DamageClaimRepo {
  static async list(caseId: string) {
    return prisma.damageClaim.findMany({ where: { caseId }, orderBy: { createdAt: "desc" } });
  }

  static async create(caseId: string, data: DamageClaimInput) {
    return prisma.damageClaim.create({ data: { caseId, ...data } });
  }

  static async update(id: string, caseId: string, data: Partial<DamageClaimInput>) {
    const existing = await prisma.damageClaim.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    return prisma.damageClaim.update({ where: { id }, data });
  }

  static async delete(id: string, caseId: string) {
    const result = await prisma.damageClaim.deleteMany({ where: { id, caseId } });
    return result.count > 0;
  }
}
