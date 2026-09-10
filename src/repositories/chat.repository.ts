import prisma from "../lib/prisma";
import { MessageRole, MessageStatus, Prisma, AudioOverviewStatus } from "@prisma/client";
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

  /** Lean id-only listing for CaseRefreshSvc, which only needs to walk each consultation's
   * messages — not scoped by organizationId since the caller already went through
   * CaseAccess.assertCanEdit for this caseId. */
  static async listConsultationIdsByCase(caseId: string) {
    return prisma.consultation.findMany({ where: { caseId }, select: { id: true } });
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
    groupId?: string,
    groupOrder?: number,
    groupTitle?: string,
    // Defaults to COMPLETE via the schema — only an assistant turn whose structured extras are
    // still being written by MessagePersistenceQueue is created "PENDING".
    status?: MessageStatus,
  ) {
    return prisma.message.create({
      data: { consultationId, role, content, userId, parentMessageId, groupId, groupOrder, groupTitle, status },
    });
  }

  /** Bulk status flip for an assistant turn's row(s) once MessagePersistenceQueue finishes
   * (COMPLETE) or gives up (FAILED). No-op on an empty list. */
  static async setMessagesStatus(messageIds: string[], status: MessageStatus) {
    if (messageIds.length === 0) return;
    return prisma.message.updateMany({ where: { id: { in: messageIds } }, data: { status } });
  }

  /** Any assistant row still PENDING well after it was created was orphaned by a process that
   * died mid-persist — its content is already saved, only the extras were lost. Flip it to
   * COMPLETE on boot so the frontend stops polling it. The age cutoff keeps this from touching
   * a sibling instance's genuinely in-flight turn. */
  static async completeStalePendingMessages(olderThanMs = 5 * 60_000) {
    return prisma.message.updateMany({
      where: { role: "assistant", status: "PENDING", createdAt: { lt: new Date(Date.now() - olderThanMs) } },
      data: { status: "COMPLETE" },
    });
  }

  /** One row per split, multi-topic AI reply — see MessageGroup. Created before the topic
   * Message rows themselves, since they each need its id as their groupId. */
  static async createMessageGroup(consultationId: string) {
    return prisma.messageGroup.create({ data: { consultationId } });
  }

  // save* are upserts (not creates) so MessagePersistenceQueue re-running a job — its SQS
  // message can redeliver after a crash between writing and acking — updates the same row
  // instead of hitting the messageId @unique constraint.
  static async saveTimeline(messageId: string, items: TimelineItem[]) {
    const items_ = items as unknown as Prisma.InputJsonValue;
    return prisma.messageTimeline.upsert({
      where: { messageId },
      create: { messageId, items: items_ },
      update: { items: items_ },
    });
  }

  static async saveMindMap(messageId: string, data: MindMapItem) {
    const data_ = data as unknown as Prisma.InputJsonValue;
    return prisma.messageMindMap.upsert({
      where: { messageId },
      create: { messageId, data: data_ },
      update: { data: data_ },
    });
  }

  /** Case-wide, not per-consultation — a case can have multiple threads, each with its own
   * map; this answers "was any map for this case regenerated recently" for staleness checks. */
  static async findLatestMindMapCreatedAtForCase(caseId: string) {
    return prisma.messageMindMap.findFirst({
      where: { message: { consultation: { caseId } } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
  }

  static async saveRelatedCases(messageId: string, items: RelatedCase[]) {
    const items_ = items as unknown as Prisma.InputJsonValue;
    return prisma.messageRelatedCases.upsert({
      where: { messageId },
      create: { messageId, items: items_ },
      update: { items: items_ },
    });
  }

  static async findMessageById(messageId: string) {
    return prisma.message.findUnique({
      where: { id: messageId },
      include: { timeline: true, mindMap: true, relatedCases: true, reasoning: true },
    });
  }

  static async saveReasoning(messageId: string, data: ReasoningExplanation) {
    const fields = {
      reasoning: data.reasoning,
      citationReasons: data.citation_reasons as unknown as Prisma.InputJsonValue,
    };
    return prisma.messageReasoning.upsert({
      where: { messageId },
      create: { messageId, ...fields },
      update: fields,
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
    const fields = { turns: turns as unknown as Prisma.InputJsonValue, voiceHostA, voiceHostB };
    return prisma.messageAudioOverview.upsert({
      where: { messageId },
      create: { messageId, ...fields },
      update: fields,
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
}
