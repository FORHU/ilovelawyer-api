import prisma from "../lib/prisma";
import { MessageRole, Prisma, AudioOverviewStatus } from "@prisma/client";
import { TimelineItem, MindMapItem, AudioOverviewTurn, ReasoningExplanation } from "../utils/response-parser";
import { RelatedCase } from "../utils/chatWonder";

export default class ChatRepo {
  /** userId is stamped for "created by" audit purposes only — a Consultation is a shared org resource. */
  static async createConsultation(organizationId: string, userId: string, title?: string, caseId?: string) {
    return prisma.consultation.create({ data: { organizationId, userId, title, caseId } });
  }

  static async listConsultations(organizationId: string, caseId?: string) {
    return prisma.consultation.findMany({
      where: { organizationId, ...(caseId ? { caseId } : {}) },
      orderBy: { createdAt: "desc" },
    });
  }

  static async findConsultationById(consultationId: string) {
    return prisma.consultation.findUnique({ where: { id: consultationId } });
  }

  static async findConsultationWithCase(consultationId: string) {
    return prisma.consultation.findUnique({
      where: { id: consultationId },
      include: { case: { include: { parties: true } } },
    });
  }

  static async updateConsultation(consultationId: string, title: string) {
    return prisma.consultation.update({ where: { id: consultationId }, data: { title } });
  }

  static async deleteConsultation(consultationId: string) {
    return prisma.consultation.delete({ where: { id: consultationId } });
  }

  static async listMessagesByConsultation(consultationId: string) {
    return prisma.message.findMany({
      where: { consultationId },
      orderBy: { createdAt: "asc" },
      include: {
        timeline: true,
        mindMap: true,
        relatedCases: true,
        audioOverview: true,
        reasoning: true,
        documents: { include: { file: true } },
      },
    });
  }

  static async createMessage(
    consultationId: string,
    role: MessageRole,
    content: string,
    userId?: string,
    parentMessageId?: string,
  ) {
    return prisma.message.create({
      data: { consultationId, role, content, userId, parentMessageId },
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

  static async saveRelatedCases(messageId: string, items: RelatedCase[]) {
    return prisma.messageRelatedCases.create({
      data: { messageId, items: items as unknown as Prisma.InputJsonValue },
    });
  }

  static async findMessageById(messageId: string) {
    return prisma.message.findUnique({
      where: { id: messageId },
      include: { timeline: true, mindMap: true, relatedCases: true, reasoning: true },
    });
  }

  static async saveReasoning(messageId: string, data: ReasoningExplanation) {
    return prisma.messageReasoning.create({
      data: {
        messageId,
        reasoning: data.reasoning,
        citationReasons: data.citation_reasons as unknown as Prisma.InputJsonValue,
      },
    });
  }

  static async findLatestAssistantMessage(consultationId: string) {
    return prisma.message.findFirst({
      where: { consultationId, role: "assistant" },
      orderBy: { createdAt: "desc" },
      include: { relatedCases: true },
    });
  }

  static async deleteMessage(messageId: string) {
    return prisma.message.delete({ where: { id: messageId } });
  }

  static async saveAudioOverview(messageId: string, turns: AudioOverviewTurn[], voiceHostA: string, voiceHostB: string) {
    return prisma.messageAudioOverview.create({
      data: { messageId, turns: turns as unknown as Prisma.InputJsonValue, voiceHostA, voiceHostB },
    });
  }

  static async findAudioOverviewByMessageId(messageId: string) {
    return prisma.messageAudioOverview.findUnique({
      where: { messageId },
      include: { audioFile: true },
    });
  }

  static async updateAudioOverviewAudio(
    messageId: string,
    data: { audioFileId?: string; audioStatus?: AudioOverviewStatus },
  ) {
    return prisma.messageAudioOverview.update({ where: { messageId }, data });
  }

  /** Re-queued on server start by AudioOverviewQueue — rows a prior process left stuck
   * mid-render (crash/redeploy) rather than ever reaching COMPLETED/FAILED. */
  static async listInProgressAudioOverviews() {
    return prisma.messageAudioOverview.findMany({
      where: { audioStatus: "IN_PROGRESS" },
      select: { messageId: true },
    });
  }

  static async listReasoningByConsultation(consultationId: string) {
    return prisma.messageReasoning.findMany({
      where: { message: { consultationId } },
      orderBy: { createdAt: "asc" },
      include: { message: { select: { id: true, consultationId: true, createdAt: true } } },
    });
  }

  /** Spans every consultation linked to the case, not just one — a case can have several. */
  static async listReasoningByCase(caseId: string) {
    return prisma.messageReasoning.findMany({
      where: { message: { consultation: { caseId } } },
      orderBy: { createdAt: "asc" },
      include: { message: { select: { id: true, consultationId: true, createdAt: true } } },
    });
  }
}
