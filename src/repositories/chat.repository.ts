import prisma from "../lib/prisma";
import { MessageRole, Prisma, AudioOverviewStatus, MessageReplyStatus } from "@prisma/client";
import { TimelineItem, MindMapItem, AudioOverviewTurn, ReasoningExplanation, DecisionRecordsPayload, TraceStep } from "../utils/response-parser";
import { RelatedCase } from "../utils/chatWonder";

export default class ChatRepo {
  /** userId is stamped for "created by" audit purposes only — a Consultation is a shared org resource. */
  static async createConsultation(organizationId: string, userId: string, title?: string, caseId?: string) {
    return prisma.consultation.create({ data: { organizationId, userId, title, caseId } });
  }

  /** With a caseId: that case's consultations. Without: only standalone (non-case) consultations,
   * so case chats don't leak into the general Consultation page's Recent list. */
  static async listConsultations(organizationId: string, caseId?: string) {
    return prisma.consultation.findMany({
      where: { organizationId, caseId: caseId ?? null },
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
        decisionRecords: true,
        researchSteps: true,
        documents: { include: { file: true } },
        generatedDocument: { include: { file: true } },
        // Verification rows for this reply (docs/plans/grounding-verifier.md). `passage` is
        // deliberately excluded: it is the slab of bundle text the verdict was reached against,
        // useful when auditing one row but far too heavy to ship on every message in a thread.
        groundingChecks: {
          select: { id: true, kind: true, assertion: true, citation: true, documentId: true, verdict: true, confidence: true, evidenceKind: true },
          orderBy: { createdAt: "asc" },
        },
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
    replyStatus?: MessageReplyStatus,
  ) {
    return prisma.message.create({
      data: { consultationId, role, content, userId, parentMessageId, groupId, groupOrder, groupTitle, replyStatus },
    });
  }

  /** Flips a user turn's replyStatus once its reply is known to be done or has failed — see
   * Message.replyStatus's doc comment. `clearPendingContent` wipes the checkpointed partial
   * text once it's superseded by the real persisted reply. */
  static async setReplyStatus(
    messageId: string,
    replyStatus: MessageReplyStatus,
    opts?: { clearPendingContent?: boolean },
  ) {
    return prisma.message.update({
      where: { id: messageId },
      data: { replyStatus, ...(opts?.clearPendingContent ? { pendingReplyContent: null } : {}) },
    });
  }

  /** A user turn's current replyStatus (and its checkpointed partial reply) — polled by the
   * generation worker to notice a Stop from another instance, and read by the cancel endpoint. */
  static async findReplyState(messageId: string) {
    return prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, consultationId: true, role: true, userId: true, replyStatus: true, pendingReplyContent: true },
    });
  }

  /** PENDING -> CANCELLED as ONE conditional write, so a Stop racing the worker's own DONE/FAILED
   * flip has exactly one winner. Returns true only if this call is the one that cancelled it. */
  static async markReplyCancelled(messageId: string, consultationId: string): Promise<boolean> {
    const { count } = await prisma.message.updateMany({
      where: { id: messageId, consultationId, role: "user", replyStatus: "PENDING" },
      data: { replyStatus: "CANCELLED", pendingReplyContent: null },
    });
    return count === 1;
  }

  /** Records a Jev triage result (urgency + intent) on the user Message and mirrors urgency onto
   * the consultation's urgentAt (set on an urgent turn, cleared on a routine one — the
   * consultation list reads that column, not the messages). One transaction so they can't
   * disagree. */
  static async setMessageTriage(
    messageId: string,
    consultationId: string,
    triage: { urgent: boolean; probability: number; intent: string; intentConfidence: number; refersToAttachment: number },
  ) {
    return prisma.$transaction([
      prisma.message.update({
        where: { id: messageId },
        data: {
          urgent: triage.urgent,
          urgencyProbability: triage.probability,
          intent: triage.intent,
          intentConfidence: triage.intentConfidence,
          refersToAttachment: triage.refersToAttachment,
        },
      }),
      prisma.consultation.update({ where: { id: consultationId }, data: { urgentAt: triage.urgent ? new Date() : null } }),
    ]);
  }

  /** Checkpoints the raw accumulated reply text while a turn is still streaming — throttled by
   * the caller (ChatSvc.processChatGenerationJob), not on every chunk. */
  static async checkpointPendingReply(messageId: string, pendingReplyContent: string) {
    return prisma.message.update({ where: { id: messageId }, data: { pendingReplyContent } });
  }

  /** One row per split, multi-topic AI reply — see MessageGroup. Created before the topic
   * Message rows themselves, since they each need its id as their groupId. */
  static async createMessageGroup(consultationId: string) {
    return prisma.messageGroup.create({ data: { consultationId } });
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

  /** `verification` is empty for now — chat-wonder-v2-api's legal_decisions.py already audits
   * each record before it ever reaches this app (per-record `rule[].verified` /
   * `evidence*[].verified` flags), so there is nothing further to re-derive here. The column
   * exists for a future app-side re-check (e.g. re-verifying a quote against a document that
   * was re-extracted after the turn) without a schema change. */
  static async saveDecisionRecords(messageId: string, data: DecisionRecordsPayload) {
    return prisma.messageDecisionRecord.create({
      data: {
        messageId,
        records: data.records as unknown as Prisma.InputJsonValue,
        verification: {} as Prisma.InputJsonValue,
      },
    });
  }

  static async saveGeneratedDocument(
    messageId: string,
    data: { fileId: string; documentType?: string; documentName?: string },
  ) {
    return prisma.messageGeneratedDocument.create({ data: { messageId, ...data } });
  }

  static async saveResearchSteps(messageId: string, steps: TraceStep[]) {
    return prisma.messageResearchSteps.create({
      data: { messageId, steps: steps as unknown as Prisma.InputJsonValue },
    });
  }

  /** Whether this user turn already has its assistant reply persisted — the idempotency check
   * for ChatSvc.persistAssistantTurn, guarding against a retried call (persistAssistantTurnWithRetry's
   * own backoff) re-splitting an already-created reply into duplicate sibling rows. A split
   * reply persists several sibling rows all sharing this parentMessageId; finding any one of
   * them means the turn is done. */
  static async findAssistantReplyByParent(parentMessageId: string) {
    return prisma.message.findFirst({ where: { parentMessageId, role: "assistant" }, select: { id: true } });
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
}
