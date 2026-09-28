import prisma from "../lib/prisma";
import { DamageCategory, DamageStatus, Prisma } from "@prisma/client";
import type { DamageBasis } from "../utils/damages-compute";

export interface DamageClaimInput {
  category: DamageCategory;
  label?: string | null;
  description?: string | null;
  amount?: number | null;
  basis?: DamageBasis | null;
  amountLow?: number | null;
  amountHigh?: number | null;
  status?: DamageStatus;
  pendingEvidence?: string | null;
  legalBasis?: string | null;
}

// A Json? column can't take a bare null — Prisma needs DbNull to clear it.
function toData<T extends Partial<DamageClaimInput>>(data: T) {
  const { basis, ...rest } = data;
  return basis === undefined
    ? rest
    : { ...rest, basis: basis === null ? Prisma.DbNull : (basis as unknown as Prisma.InputJsonValue) };
}

export default class DamageClaimRepo {
  static async list(caseId: string) {
    return prisma.damageClaim.findMany({ where: { caseId }, orderBy: { createdAt: "desc" } });
  }

  static async findById(id: string, caseId: string) {
    return prisma.damageClaim.findFirst({ where: { id, caseId } });
  }

  static async create(caseId: string, data: DamageClaimInput) {
    return prisma.damageClaim.create({ data: { caseId, ...toData(data) } });
  }

  static async update(id: string, caseId: string, data: Partial<DamageClaimInput>) {
    const existing = await prisma.damageClaim.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    return prisma.damageClaim.update({ where: { id }, data: toData(data) });
  }

  /** Writes recomputed amounts back in one transaction (see DamageClaimSvc.recompute). */
  static async setAmounts(changes: { id: string; amount: number | null }[]) {
    if (changes.length === 0) return;
    await prisma.$transaction(
      changes.map((c) => prisma.damageClaim.update({ where: { id: c.id }, data: { amount: c.amount } })),
    );
  }

  static async delete(id: string, caseId: string) {
    const result = await prisma.damageClaim.deleteMany({ where: { id, caseId } });
    return result.count > 0;
  }
}
