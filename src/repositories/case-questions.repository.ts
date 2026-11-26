import { CaseQuestionsStatus, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { openIntakeField, sealIntakeField } from "../utils/intake-field-crypto";
import type { QuestionPlan } from "../utils/client-questions-plan";

/** Bound into the sealed value, as IntakeMessage's labels are. */
export const CASE_QUESTIONS_PLAN = "CaseQuestions.plan";

export interface CaseQuestionsRow {
  caseId: string;
  status: CaseQuestionsStatus;
  total: number;
  /** Null while PLANNING, or when the stored list can't be opened (logged by openIntakeField). */
  plan: QuestionPlan | null;
  updatedAt: Date;
}

function openPlan(stored: string | null): QuestionPlan | null {
  if (!stored) return null;
  const opened = openIntakeField(stored, CASE_QUESTIONS_PLAN);
  if (!opened) return null;
  try {
    return JSON.parse(opened) as QuestionPlan;
  } catch {
    return null;
  }
}

/** A case's Questions list (CaseQuestions): sealed on the way in, opened on the way out. */
export default class CaseQuestionsRepo {
  static async find(caseId: string): Promise<CaseQuestionsRow | null> {
    const row = await prisma.caseQuestions.findUnique({ where: { caseId } });
    return row ? { caseId: row.caseId, status: row.status, total: row.total, plan: openPlan(row.plan), updatedAt: row.updatedAt } : null;
  }

  /** Marks the list as being written. False when another request got there first (the row exists). */
  static async claim(caseId: string): Promise<boolean> {
    try {
      await prisma.caseQuestions.create({ data: { caseId, status: "PLANNING" } });
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
      throw err;
    }
  }

  static async save(caseId: string, data: { status: CaseQuestionsStatus; total: number; plan: QuestionPlan }): Promise<void> {
    await prisma.caseQuestions.update({
      where: { caseId },
      data: { status: data.status, total: data.total, plan: sealIntakeField(JSON.stringify(data.plan), CASE_QUESTIONS_PLAN, true) },
    });
  }

  /** Saves an answer's change to the list only if nothing else saved one since `seen` (when it was
   * read): two quick answers never overwrite each other. False when another got there first. */
  static async saveIfUnchanged(caseId: string, seen: Date, data: { status: CaseQuestionsStatus; plan: QuestionPlan }): Promise<boolean> {
    const { count } = await prisma.caseQuestions.updateMany({
      where: { caseId, updatedAt: seen },
      // Set here rather than left to @updatedAt, which is the stamp the next answer compares against.
      data: { status: data.status, plan: sealIntakeField(JSON.stringify(data.plan), CASE_QUESTIONS_PLAN, true), updatedAt: new Date() },
    });
    return count === 1;
  }

  /** Drops a list being written that failed or was abandoned, so the next start writes it again. */
  static async release(caseId: string): Promise<void> {
    await prisma.caseQuestions.deleteMany({ where: { caseId, status: "PLANNING" } });
  }
}
