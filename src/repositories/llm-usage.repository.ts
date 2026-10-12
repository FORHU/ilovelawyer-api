import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

export default class LlmUsageRepo {
  static async create(data: Prisma.LlmUsageUncheckedCreateInput) {
    return prisma.llmUsage.create({ data });
  }

  /** Who owns a case, for attributing the LLM work done on it. Null for an id that is not a case. */
  static async findCaseOwner(caseId: string) {
    return prisma.case.findUnique({ where: { id: caseId }, select: { userId: true, organizationId: true } });
  }

  static async findDocumentOwner(documentId: string) {
    return prisma.document.findUnique({ where: { id: documentId }, select: { userId: true, organizationId: true, caseId: true, consultationId: true } });
  }
}
