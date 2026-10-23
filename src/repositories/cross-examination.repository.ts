import { CrossExamStatus } from "@prisma/client";
import prisma from "../lib/prisma";

/** One AI-proposed question as replaceAiQuestions stores it, already checked against its document. */
export interface AiCrossExamRow {
  topic: string;
  question: string;
  purpose: string | null;
  sourceDocumentId: string;
  sourceQuote: string;
  pageNumber: number | null;
  supportVerdict: string;
  supportConfidence: number;
}

export interface CrossExamEdit {
  status?: CrossExamStatus;
  topic?: string;
  question?: string;
  purpose?: string | null;
}

const questionKey = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

export default class CrossExamRepo {
  static async find(id: string, caseId: string) {
    return prisma.crossExamQuestion.findFirst({ where: { id, caseId } });
  }

  /** In the order they would be asked, with the source document's name for the citation line. */
  static async listByWitness(caseId: string, witnessId: string) {
    return prisma.crossExamQuestion.findMany({
      where: { caseId, witnessId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      include: { sourceDocument: { select: { id: true, name: true } } },
    });
  }

  /**
   * A regeneration: PROPOSED rows nobody edited are replaced; a row the lawyer accepted, rejected
   * or edited is kept, and a fresh question with the same text as a kept one is not added again —
   * so a rejected question doesn't come back. Fresh rows are numbered after the kept ones.
   */
  static async replaceAiQuestions(caseId: string, witnessId: string, rows: AiCrossExamRow[]) {
    await prisma.$transaction(async (tx) => {
      await tx.crossExamQuestion.deleteMany({
        where: { caseId, witnessId, status: "PROPOSED", lawyerEditedAt: null },
      });
      const kept = await tx.crossExamQuestion.findMany({
        where: { caseId, witnessId },
        select: { question: true, position: true },
      });
      const keptKeys = new Set(kept.map((row) => questionKey(row.question)));
      const start = kept.reduce((max, row) => Math.max(max, row.position + 1), 0);
      const fresh = rows.filter((row) => !keptKeys.has(questionKey(row.question)));
      if (fresh.length === 0) return;
      await tx.crossExamQuestion.createMany({
        data: fresh.map((row, i) => ({ ...row, caseId, witnessId, position: start + i })),
      });
    });
    return this.listByWitness(caseId, witnessId);
  }

  /** The lawyer's review. Rewording the question clears Jev's verdict, which was about the old
   * wording; a status change alone keeps it. Either marks the row as the lawyer's, so a
   * regeneration leaves it alone. */
  static async update(id: string, caseId: string, edit: CrossExamEdit) {
    const existing = await prisma.crossExamQuestion.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    const reworded = edit.question !== undefined && questionKey(edit.question) !== questionKey(existing.question);
    return prisma.crossExamQuestion.update({
      where: { id },
      data: {
        ...edit,
        ...(reworded ? { supportVerdict: null, supportConfidence: null } : {}),
        lawyerEditedAt: new Date(),
      },
      include: { sourceDocument: { select: { id: true, name: true } } },
    });
  }

  static async delete(id: string, caseId: string): Promise<boolean> {
    const { count } = await prisma.crossExamQuestion.deleteMany({ where: { id, caseId } });
    return count > 0;
  }
}
