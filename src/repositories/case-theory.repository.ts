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

  /** Deletes the theory with everything that points at it by id alone (no FK, so no cascade):
   * cached diffs it's half of, and notes left on it. Claims/assumptions/open questions cascade. */
  static async deleteWithDependents(id: string, caseId: string) {
    const [, , result] = await prisma.$transaction([
      prisma.theoryDiff.deleteMany({ where: { caseId, OR: [{ theoryAId: id }, { theoryBId: id }] } }),
      prisma.annotation.deleteMany({ where: { caseId, targetType: "NODE", targetId: id } }),
      prisma.caseTheory.deleteMany({ where: { id, caseId } }),
    ]);
    return result.count > 0;
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

  // Update/delete are scoped by theoryId too, so an item id from another theory can't be
  // reached through a theory the caller does own. Updates return null when nothing matched.

  static async updateClaim(id: string, theoryId: string, data: { statement?: string; stance?: TheoryStance }) {
    const result = await prisma.theoryClaim.updateMany({ where: { id, theoryId }, data });
    if (result.count === 0) return null;
    return prisma.theoryClaim.findUnique({ where: { id } });
  }

  static async deleteClaim(id: string, theoryId: string) {
    const result = await prisma.theoryClaim.deleteMany({ where: { id, theoryId } });
    return result.count > 0;
  }

  static async updateAssumption(id: string, theoryId: string, statement: string) {
    const result = await prisma.theoryAssumption.updateMany({ where: { id, theoryId }, data: { statement } });
    if (result.count === 0) return null;
    return prisma.theoryAssumption.findUnique({ where: { id } });
  }

  static async deleteAssumption(id: string, theoryId: string) {
    const result = await prisma.theoryAssumption.deleteMany({ where: { id, theoryId } });
    return result.count > 0;
  }

  static async updateOpenQuestion(id: string, theoryId: string, question: string) {
    const result = await prisma.theoryOpenQuestion.updateMany({ where: { id, theoryId }, data: { question } });
    if (result.count === 0) return null;
    return prisma.theoryOpenQuestion.findUnique({ where: { id } });
  }

  static async deleteOpenQuestion(id: string, theoryId: string) {
    const result = await prisma.theoryOpenQuestion.deleteMany({ where: { id, theoryId } });
    return result.count > 0;
  }
}
