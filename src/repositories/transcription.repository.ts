import prisma from "../lib/prisma";

export default class TranscriptionRepo {
  static async findAllByUser(userId: string) {
    return prisma.transcription.findMany({
      where: { userId },
      include: { audioFile: true },
      orderBy: { createdAt: "desc" },
    });
  }

  static async findAllByCase(userId: string, caseId: string) {
    return prisma.transcription.findMany({
      where: { userId, caseId },
      include: { audioFile: true },
      orderBy: { createdAt: "desc" },
    });
  }

  static async findById(id: string, userId: string) {
    return prisma.transcription.findFirst({
      where: { id, userId },
      include: { audioFile: true },
    });
  }

  static async create(userId: string, data: {
    title?: string;
    audioFileId?: string;
    transcript?: string;
    duration?: number;
    jobName?: string;
    status?: string;
    caseId?: string | null;
  }) {
    return prisma.transcription.create({
      data: { userId, ...data },
      include: { audioFile: true },
    });
  }

  static async update(id: string, userId: string, data: {
    title?: string;
    audioFileId?: string;
    transcript?: string;
    duration?: number;
    jobName?: string;
    status?: string;
    caseId?: string | null;
  }) {
    return prisma.transcription.updateMany({
      where: { id, userId },
      data,
    });
  }

  static async delete(id: string, userId: string) {
    return prisma.transcription.deleteMany({ where: { id, userId } });
  }
}
