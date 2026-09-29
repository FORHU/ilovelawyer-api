import prisma from "../lib/prisma";
import { DamageCategory, DamageStatus, Prisma } from "@prisma/client";
import type { DamageBasis } from "../utils/damages-compute";
import type { DamageProposal } from "../utils/damages-proposal";

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

export interface DamageAiExtractInput {
  category: DamageCategory;
  label: string | null;
  basis: DamageBasis;
  amount: number | null;
  legalBasis: string | null;
  pendingEvidence: string | null;
  sourceDocumentId: string;
  sourceQuote: string;
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

  /** A head proposed by DamagesExtractSvc — always source AI and PROVISIONAL, with the document and
   * verbatim quote it came from. */
  static async createFromAi(caseId: string, data: DamageAiExtractInput) {
    const { basis, ...rest } = data;
    return prisma.damageClaim.create({
      data: { caseId, source: "AI", status: "PROVISIONAL", ...rest, basis: basis as unknown as Prisma.InputJsonValue },
    });
  }

  /** Stores (or, with null, clears) a suggested update — see DamageProposal in damages-proposal.ts. */
  static async setProposal(id: string, caseId: string, proposal: DamageProposal | null) {
    await prisma.damageClaim.updateMany({
      where: { id, caseId },
      data: { aiProposedBasis: proposal === null ? Prisma.DbNull : (proposal as unknown as Prisma.InputJsonValue) },
    });
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
