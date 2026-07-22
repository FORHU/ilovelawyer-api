import prisma from "../lib/prisma";

export default class InviteRepo {
  static async create(conversationId: string, createdBy: string, expiresAt: Date) {
    return prisma.conversationInvite.create({
      data: { conversationId, createdBy, expiresAt },
    });
  }

  static async findById(id: string) {
    return prisma.conversationInvite.findUnique({
      where: { id },
      include: { conversation: true, creator: { select: { id: true, name: true, email: true } } },
    });
  }

  static async listByConversation(conversationId: string) {
    return prisma.conversationInvite.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
    });
  }

  static async delete(id: string) {
    return prisma.conversationInvite.delete({ where: { id } });
  }
}
