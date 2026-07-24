import prisma from "../lib/prisma";
import { MessageRole, Prisma } from "@prisma/client";
import { TimelineItem, MindMapItem } from "../utils/response-parser";

export default class ChatRepo {
  static async createConversation(userId: string, title?: string, caseId?: string) {
    return prisma.conversation.create({ data: { userId, title, caseId } });
  }

  static async listConversations(userId: string, caseId?: string) {
    return prisma.conversation.findMany({
      where: { userId, ...(caseId ? { caseId } : {}) },
      orderBy: { createdAt: "desc" },
    });
  }

  static async findConversationById(conversationId: string) {
    return prisma.conversation.findUnique({ where: { id: conversationId } });
  }

  static async findConversationWithCase(conversationId: string) {
    return prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { case: { include: { parties: true } } },
    });
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
      include: { timeline: true, mindMap: true },
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

  static async saveTimeline(messageId: string, items: TimelineItem[]) {
    return prisma.messageTimeline.create({
      data: { messageId, items: items as unknown as Prisma.InputJsonValue },
    });
  }

  static async saveMindMap(messageId: string, data: MindMapItem) {
    return prisma.messageMindMap.create({
      data: { messageId, data: data as unknown as Prisma.InputJsonValue },
    });
  }

  static async findMessageById(messageId: string) {
    return prisma.message.findUnique({ where: { id: messageId }, include: { timeline: true, mindMap: true } });
  }

  static async deleteMessage(messageId: string) {
    return prisma.message.delete({ where: { id: messageId } });
  }
}
