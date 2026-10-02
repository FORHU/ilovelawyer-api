import prisma from "../lib/prisma";
import { AiGenerationKind } from "../constants";

export default class AiGenerationJobRepo {
  static async findBySubjectAndKind(subjectId: string, kind: AiGenerationKind) {
    return prisma.aiGenerationJob.findUnique({ where: { subjectId_kind: { subjectId, kind } } });
  }

  static async create(subjectId: string, kind: AiGenerationKind) {
    return prisma.aiGenerationJob.create({ data: { subjectId, kind } });
  }

  /** Reclaims a finished/stale row for a fresh run — see AiGenerationLockSvc.begin. */
  static async markInProgress(subjectId: string, kind: AiGenerationKind) {
    return prisma.aiGenerationJob.update({
      where: { subjectId_kind: { subjectId, kind } },
      data: { status: "IN_PROGRESS", startedAt: new Date(), finishedAt: null, error: null, stage: null },
    });
  }

  static async updateStatus(subjectId: string, kind: AiGenerationKind, status: "DONE" | "FAILED", error?: string) {
    return prisma.aiGenerationJob.update({
      where: { subjectId_kind: { subjectId, kind } },
      data: { status, finishedAt: new Date(), error: error ?? null },
    });
  }

  /** Records an IN_PROGRESS job's stage. Filtered on IN_PROGRESS so a stage report that lands
   * after the job finished (they're fire-and-forget) can't touch the finished row; returns
   * whether it did anything. */
  static async updateStage(subjectId: string, kind: AiGenerationKind, stage: string): Promise<boolean> {
    const { count } = await prisma.aiGenerationJob.updateMany({
      where: { subjectId, kind, status: "IN_PROGRESS" },
      data: { stage },
    });
    return count > 0;
  }
}
