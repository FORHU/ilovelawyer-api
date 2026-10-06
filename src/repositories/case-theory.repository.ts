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

  /** The case's newest AI-authored theory — the one CaseTheorySvc.proposeInner rewrites in place. */
  static async findLatestAiDraft(caseId: string) {
    return prisma.caseTheory.findFirst({ where: { caseId, authorUserId: null }, orderBy: { createdAt: "desc" } });
  }

  /** Rewrites an AI draft in place: new title/thesis, claims, assumptions and open questions,
   * and drops the cached diffs it's half of, since they describe the old text. The id stays,
   * so forks (forkedFromId) and notes on it keep pointing at it. AI claims never carry a
   * graphNodeId, so there are no mirrored CaseEdges to clean up. */
  static async replaceAiDraft(
    id: string,
    caseId: string,
    proposal: {
      title: string;
      thesis: string;
      claims: { statement: string; stance: TheoryStance }[];
      assumptions: string[];
      openQuestions: string[];
    },
  ) {
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.caseTheory.updateMany({
        where: { id, caseId, authorUserId: null },
        data: { title: proposal.title, thesis: proposal.thesis },
      });
      if (updated.count === 0) return 0;
      await tx.theoryClaim.deleteMany({ where: { theoryId: id } });
      await tx.theoryAssumption.deleteMany({ where: { theoryId: id } });
      await tx.theoryOpenQuestion.deleteMany({ where: { theoryId: id } });
      await tx.theoryDiff.deleteMany({ where: { caseId, OR: [{ theoryAId: id }, { theoryBId: id }] } });
      await tx.theoryClaim.createMany({ data: proposal.claims.map((c) => ({ theoryId: id, statement: c.statement, stance: c.stance })) });
      await tx.theoryAssumption.createMany({ data: proposal.assumptions.map((statement) => ({ theoryId: id, statement })) });
      await tx.theoryOpenQuestion.createMany({ data: proposal.openQuestions.map((question) => ({ theoryId: id, question })) });
      return updated.count;
    });
    if (result === 0) return null;
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
