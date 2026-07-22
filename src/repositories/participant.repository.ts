import prisma from "../lib/prisma";

export default class ParticipantRepo {
  static async add(conversationId: string, userId: string) {
    return prisma.conversationParticipant.upsert({
      where: { conversationId_userId: { conversationId, userId } },
      create: { conversationId, userId },
      update: {},
    });
  }

  static async list(conversationId: string) {
    return prisma.conversationParticipant.findMany({
      where: { conversationId },
      include: { user: { select: { id: true, name: true, email: true, username: true } } },
      orderBy: { joinedAt: "asc" },
    });
  }

  static async remove(conversationId: string, userId: string) {
    return prisma.conversationParticipant.delete({
      where: { conversationId_userId: { conversationId, userId } },
    });
  }

  static async exists(conversationId: string, userId: string) {
    const row = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    return !!row;
  }
}
