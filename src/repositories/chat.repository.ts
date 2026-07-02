import prisma from "../lib/prisma";
import { MessageRole } from "@prisma/client";

export default class ChatRepo {
  static async createConversation(userId: string, title?: string) {
    return prisma.conversation.create({ data: { userId, title } });
  }

  static async listConversations(userId: string) {
    return prisma.conversation.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  static async findConversationById(conversationId: string) {
    return prisma.conversation.findUnique({ where: { id: conversationId } });
  }

  static async updateConversation(conversationId: string, title: string) {
    return prisma.conversation.update({ where: { id: conversationId }, data: { title } });
  }

  static async deleteConversation(conversationId: string) {
    return prisma.conversation.delete({ where: { id: conversationId } });
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

  static async findMessageById(messageId: string) {
    return prisma.message.findUnique({ where: { id: messageId } });
  }

  static async deleteMessage(messageId: string) {
    return prisma.message.delete({ where: { id: messageId } });
  }
}
