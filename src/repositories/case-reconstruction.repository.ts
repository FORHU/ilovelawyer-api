import prisma from "../lib/prisma";

export default class CaseReconstructionRepo {
  static async get(caseId: string) {
    return prisma.caseReconstruction.findUnique({ where: { caseId } });
  }

  static async upsert(caseId: string, narrative: string) {
    return prisma.caseReconstruction.upsert({
      where: { caseId },
      create: { caseId, narrative },
      update: { narrative },
    });
  }
}
