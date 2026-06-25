import prisma from "../lib/prisma";
import { MessageRole } from "@prisma/client";

export default class ChatRepo {
  static async createConversation(userId: string, title?: string) {
    return prisma.conversation.create({ data: { userId, title } });
  }

  static async findConversationById(conversationId: string) {
    return prisma.conversation.findUnique({ where: { id: conversationId } });
  }

  static async listMessagesByConversation(conversationId: string) {
    return prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });
  }

  static async createMessage(
    conversationId: string,
    role: MessageRole,
    content: string,
    userId?: string,
    parentMessageId?: string,
  ) {
    return prisma.message.create({
      data: { conversationId, role, content, userId, parentMessageId },
    });
  }
}
