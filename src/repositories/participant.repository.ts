import prisma from "../lib/prisma";

export default class ParticipantRepo {
  static async add(consultationId: string, userId: string) {
    return prisma.consultationParticipant.upsert({
      where: { consultationId_userId: { consultationId, userId } },
      create: { consultationId, userId },
      update: {},
    });
  }

  static async list(consultationId: string) {
    return prisma.consultationParticipant.findMany({
      where: { consultationId },
      include: { user: { select: { id: true, name: true, email: true, username: true } } },
      orderBy: { joinedAt: "asc" },
    });
  }

  static async remove(consultationId: string, userId: string) {
    return prisma.consultationParticipant.delete({
      where: { consultationId_userId: { consultationId, userId } },
    });
  }

  static async exists(consultationId: string, userId: string) {
    const row = await prisma.consultationParticipant.findUnique({
      where: { consultationId_userId: { consultationId, userId } },
    });
    return !!row;
  }
}
