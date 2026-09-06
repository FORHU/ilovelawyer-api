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
      data: { status: "IN_PROGRESS", startedAt: new Date(), finishedAt: null, error: null },
    });
  }

  static async updateStatus(subjectId: string, kind: AiGenerationKind, status: "DONE" | "FAILED", error?: string) {
    return prisma.aiGenerationJob.update({
      where: { subjectId_kind: { subjectId, kind } },
      data: { status, finishedAt: new Date(), error: error ?? null },
    });
  }
}
