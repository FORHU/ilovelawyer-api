import prisma from "../lib/prisma";
import CaseAccess from "../utils/case-access";
import { RagStatus } from "@prisma/client";
import { organizationIdOf, scopeWhere, type WorkspaceScope } from "../utils/workspace";

export default class TranscriptionRepo {
  /** The organization's transcriptions, minus those on a case `userId` can't open (#346). */
  static async findAllByUser(scope: WorkspaceScope, userId: string) {
    return prisma.transcription.findMany({
      where: { ...scopeWhere(scope), OR: [{ caseId: null }, { case: CaseAccess.visibleWhere(userId) }] },
      include: { audioFile: true },
      orderBy: { createdAt: "desc" },
    });
  }

  static async findAllByCase(scope: WorkspaceScope, caseId: string) {
    return prisma.transcription.findMany({
      where: { ...scopeWhere(scope), caseId },
      include: { audioFile: true },
      orderBy: { createdAt: "desc" },
    });
  }

  static async findById(id: string, scope: WorkspaceScope) {
    return prisma.transcription.findFirst({
      where: { id, ...scopeWhere(scope) },
      include: { audioFile: true },
    });
  }

  /** userId is stamped for "created by" audit purposes only — reads/updates/deletes below scope by the workspace (scopeWhere). */
  static async create(scope: WorkspaceScope, userId: string, data: {
    title?: string;
    audioFileId?: string;
    transcript?: string;
    duration?: number;
    jobName?: string;
    status?: string;
    caseId?: string | null;
    consultationId?: string | null;
  }) {
    return prisma.transcription.create({
      data: { organizationId: organizationIdOf(scope), userId, ...data },
      include: { audioFile: true },
    });
  }

  static async update(id: string, scope: WorkspaceScope, data: {
    title?: string;
    audioFileId?: string;
    transcript?: string;
    duration?: number;
    jobName?: string;
    status?: string;
    caseId?: string | null;
    consultationId?: string | null;
  }) {
    return prisma.transcription.updateMany({
      where: { id, ...scopeWhere(scope) },
      data,
    });
  }

  static async delete(id: string, scope: WorkspaceScope) {
    return prisma.transcription.deleteMany({ where: { id, ...scopeWhere(scope) } });
  }

  /** Unscoped — ownership is already checked at the controller/service boundary
   * before the chunk pipeline (a background-ish step, mirrors DocumentRepo.findByIdWithFile). */
  static async findByIdAny(id: string) {
    return prisma.transcription.findUnique({ where: { id } });
  }

  static async updateRagStatus(id: string, ragStatus: RagStatus) {
    return prisma.transcription.update({ where: { id }, data: { ragStatus } });
  }
}
