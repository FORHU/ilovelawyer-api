import prisma from "../lib/prisma";

export default class RedTeamRepo {
  static async get(caseId: string) {
    return prisma.redTeamAssessment.findUnique({ where: { caseId } });
  }

  static async upsert(caseId: string, content: string) {
    return prisma.redTeamAssessment.upsert({
      where: { caseId },
      create: { caseId, content },
      update: { content },
    });
  }
}
