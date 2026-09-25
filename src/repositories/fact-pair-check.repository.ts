import prisma from "../lib/prisma";
import { ContradictionNature } from "@prisma/client";

/** Cache of Jev's verdict per full-scan candidate pair — see FullContradictionScanSvc. */
export default class FactPairCheckRepo {
  static async findByKeys(caseId: string, pairKeys: string[]) {
    if (!pairKeys.length) return [];
    return prisma.factPairCheck.findMany({ where: { caseId, pairKey: { in: pairKeys } } });
  }

  static async saveMany(caseId: string, rows: { pairKey: string; nature: ContradictionNature; confidence: number }[]) {
    if (!rows.length) return;
    await prisma.factPairCheck.createMany({
      data: rows.map((row) => ({ caseId, ...row })),
      skipDuplicates: true,
    });
  }
}
