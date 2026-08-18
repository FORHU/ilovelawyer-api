import prisma from "../lib/prisma";
import { RagStatus } from "@prisma/client";

export default class TranscriptionRepo {
  static async findAllByUser(organizationId: string) {
    return prisma.transcription.findMany({
      where: { organizationId },
      include: { audioFile: true },
      orderBy: { createdAt: "desc" },
    });
  }

  static async findAllByCase(organizationId: string, caseId: string) {
    return prisma.transcription.findMany({
      where: { organizationId, caseId },
      include: { audioFile: true },
      orderBy: { createdAt: "desc" },
    });
  }

  static async findById(id: string, organizationId: string) {
    return prisma.transcription.findFirst({
      where: { id, organizationId },
      include: { audioFile: true },
    });
  }

  /** userId is stamped for "created by" audit purposes only — reads/updates/deletes below scope by organizationId. */
  static async create(organizationId: string, userId: string, data: {
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
      data: { organizationId, userId, ...data },
      include: { audioFile: true },
    });
  }

  static async update(id: string, organizationId: string, data: {
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
      where: { id, organizationId },
      data,
    });
  }

  static async delete(id: string, organizationId: string) {
    return prisma.transcription.deleteMany({ where: { id, organizationId } });
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
