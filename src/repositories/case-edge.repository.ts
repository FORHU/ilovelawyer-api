import prisma from "../lib/prisma";
import { CaseEdgeRelationType, Prisma } from "@prisma/client";

export interface CaseEdgeInput {
  sourceEntityId: string;
  targetEntityId: string;
  relationType: CaseEdgeRelationType;
  metadata?: Prisma.InputJsonValue;
}

export default class CaseEdgeRepo {
  static async create(caseId: string, data: CaseEdgeInput) {
    return prisma.caseEdge.create({ data: { caseId, ...data } });
  }

  static async listForCase(caseId: string) {
    return prisma.caseEdge.findMany({ where: { caseId } });
  }

  static async delete(id: string, caseId: string) {
    const result = await prisma.caseEdge.deleteMany({ where: { id, caseId } });
    return result.count > 0;
  }

  static async listArchivedForCase(caseId: string) {
    return prisma.caseEdgeArchive.findMany({ where: { caseId }, orderBy: { archivedAt: "desc" } });
  }
}
