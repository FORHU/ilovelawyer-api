import { GroundRole, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

export interface AiCitationGroundRow {
  citationCheckId: string;
  claimId: string;
  role: GroundRole;
  reason: string | null;
  jev?: Prisma.InputJsonValue;
  jevCheckedAt?: Date | null;
}

export default class CitationGroundRepo {
  static async list(caseId: string) {
    return prisma.citationGround.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } });
  }

  static async find(id: string, caseId: string) {
    return prisma.citationGround.findFirst({ where: { id, caseId } });
  }

  static async createManual(caseId: string, data: { citationCheckId: string; claimId: string; role: GroundRole }) {
    return prisma.citationGround.create({ data: { caseId, source: "MANUAL", ...data } });
  }

  static async setJevCheck(id: string, check: Prisma.InputJsonValue) {
    return prisma.citationGround.update({ where: { id }, data: { jev: check, jevCheckedAt: new Date() } });
  }

  static async delete(id: string, caseId: string) {
    const result = await prisma.citationGround.deleteMany({ where: { id, caseId } });
    return result.count > 0;
  }

  /** Replaces every AI link with a fresh mapping run's. Manual links are untouched, and an AI link
   * for a pair the lawyer already linked by hand is skipped (skipDuplicates on the unique pair). */
  static async replaceAi(caseId: string, rows: AiCitationGroundRow[]) {
    await prisma.$transaction(async (tx) => {
      await tx.citationGround.deleteMany({ where: { caseId, source: "AI" } });
      if (rows.length === 0) return;
      await tx.citationGround.createMany({
        data: rows.map((row) => ({ ...row, caseId, source: "AI" as const })),
        skipDuplicates: true,
      });
    });
    return this.list(caseId);
  }
}
