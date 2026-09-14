import prisma from "../lib/prisma";
import { TheoryStance, TheoryStatus } from "@prisma/client";

export interface CaseTheoryCreateInput {
  authorUserId: string | null;
  title: string;
  thesis: string;
  status?: TheoryStatus;
  forkedFromId?: string | null;
}

const WITH_DETAILS = {
  claims: { orderBy: { createdAt: "asc" as const } },
  assumptions: { orderBy: { createdAt: "asc" as const } },
  openQuestions: { orderBy: { createdAt: "asc" as const } },
};

export default class CaseTheoryRepo {
  static async create(caseId: string, data: CaseTheoryCreateInput) {
    return prisma.caseTheory.create({ data: { caseId, ...data }, include: WITH_DETAILS });
  }

  static async list(caseId: string) {
    return prisma.caseTheory.findMany({
      where: { caseId },
      orderBy: { createdAt: "asc" },
      include: WITH_DETAILS,
    });
  }

  static async findById(id: string, caseId: string) {
    return prisma.caseTheory.findFirst({ where: { id, caseId }, include: WITH_DETAILS });
  }

  static async update(
    id: string,
    caseId: string,
    data: { title?: string; thesis?: string; status?: TheoryStatus },
  ) {
    const result = await prisma.caseTheory.updateMany({ where: { id, caseId }, data });
    if (result.count === 0) return null;
    return CaseTheoryRepo.findById(id, caseId);
  }

  static async addClaim(theoryId: string, data: { statement: string; stance: TheoryStance; graphNodeId?: string | null }) {
    return prisma.theoryClaim.create({ data: { theoryId, ...data } });
  }

  static async addAssumption(theoryId: string, statement: string) {
    return prisma.theoryAssumption.create({ data: { theoryId, statement } });
  }

  static async addOpenQuestion(theoryId: string, question: string) {
    return prisma.theoryOpenQuestion.create({ data: { theoryId, question } });
  }
}
