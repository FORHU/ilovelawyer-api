import prisma from "../lib/prisma";
import { DamageKind } from "@prisma/client";

export interface DamageClaimInput {
  kind: DamageKind;
  title: string;
  description?: string | null;
  amount?: number | null;
  done?: boolean;
  dueDate?: Date | null;
}

export interface DamageAiExtractInput {
  kind: DamageKind;
  title: string;
  description: string | null;
  amount: number | null;
  sourceDocumentId: string;
  sourceQuote: string;
}

export default class DamageClaimRepo {
  static async list(caseId: string) {
    return prisma.damageClaim.findMany({ where: { caseId }, orderBy: { createdAt: "desc" } });
  }

  static async findById(id: string, caseId: string) {
    return prisma.damageClaim.findFirst({ where: { id, caseId } });
  }

  static async create(caseId: string, data: DamageClaimInput) {
    return prisma.damageClaim.create({ data: { caseId, ...data } });
  }

  static async update(id: string, caseId: string, data: Partial<DamageClaimInput> & { accepted?: boolean }) {
    const existing = await prisma.damageClaim.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    return prisma.damageClaim.update({ where: { id }, data });
  }

  /** An entry proposed by DamagesExtractSvc — source AI, not accepted until a lawyer says so, with
   * the document and verbatim quote it came from. */
  static async createFromAi(caseId: string, data: DamageAiExtractInput) {
    return prisma.damageClaim.create({ data: { caseId, source: "AI", accepted: false, ...data } });
  }

  static async delete(id: string, caseId: string) {
    const result = await prisma.damageClaim.deleteMany({ where: { id, caseId } });
    return result.count > 0;
  }
}
