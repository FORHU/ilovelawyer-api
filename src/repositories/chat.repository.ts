import prisma from "../lib/prisma";
import { MessageRole, Prisma, AudioOverviewStatus, MessageReplyStatus, ConsultationStatus } from "@prisma/client";
import { TimelineItem, MindMapItem, AudioOverviewTurn, ReasoningExplanation, DecisionRecordsPayload, TraceStep } from "../utils/response-parser";
import { RelatedCase } from "../utils/chatWonder";
import type { MarkTiming } from "../utils/audio-overview-render";
import { consultationDeletionDueAt } from "../constants/consultation-deletion.constants";

export default class ChatRepo {
  /** userId is stamped for "created by" audit purposes only — a Consultation is a shared org resource. */
  static async createConsultation(organizationId: string, userId: string, title?: string, caseId?: string) {
    return prisma.consultation.create({ data: { organizationId, userId, title, caseId, titleSource: title ? "USER" : null } });
  }

  /** With a caseId: that case's consultations. Without: only standalone (non-case) consultations,
   * so case chats don't leak into the general Consultation page's Recent list.
   *
   * Most recently *active* first — `lastMessageAt` (newest message), falling back to `createdAt`
   * for one with no messages yet — so a Case opens on the thread last worked in, not merely the
   * newest one. Each row also carries who started it and how many messages it holds, for the
   * Case Workspace's Consultation switcher. */
  /** ACTIVE lists by latest activity. ARCHIVED is the archive as shown — those scheduled for
   * deletion (FOR_DELETION) included, since they can still be restored — by when each was
   * archived, newest first. */
  static async listConsultations(organizationId: string, caseId?: string, status: Exclude<ConsultationStatus, "FOR_DELETION"> = "ACTIVE") {
    const rows = await prisma.consultation.findMany({
      where: {
        organizationId,
        caseId: caseId ?? null,
        status: status === "ARCHIVED" ? { in: ["ARCHIVED", "FOR_DELETION"] } : status,
      },
      orderBy: { createdAt: "desc" },
      include: {
        user: { select: { id: true, name: true, username: true } },
        _count: { select: { messages: true } },
      },
    });
    if (rows.length === 0) return [];

    const latest = await prisma.message.groupBy({
      by: ["consultationId"],
      where: { consultationId: { in: rows.map((r) => r.id) } },
      _max: { createdAt: true },
    });
    const lastMessageAt = new Map(latest.map((l) => [l.consultationId, l._max.createdAt]));

    const sortKey = (c: { archivedAt: Date | null; lastMessageAt: Date | null; createdAt: Date }) =>
      (status === "ARCHIVED" ? c.archivedAt : c.lastMessageAt) ?? c.createdAt;
    return rows
      .map(({ user, _count, ...consultation }) => ({
        ...consultation,
        createdBy: user,
        messageCount: _count.messages,
        lastMessageAt: lastMessageAt.get(consultation.id) ?? null,
        // When a requested deletion takes effect — the archive shows the countdown.
        deletionScheduledFor: consultation.deletionRequestedAt ? consultationDeletionDueAt(consultation.deletionRequestedAt) : null,
      }))
      .sort((a, b) => sortKey(b).getTime() - sortKey(a).getTime());
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

  static async findConsultationTitleState(consultationId: string) {
    return prisma.consultation.findUnique({ where: { id: consultationId }, select: { title: true, titleSource: true } });
  }

  /** A user rename — locks the title against any later AI re-titling. */
  static async updateConsultation(consultationId: string, title: string) {
    return prisma.consultation.update({ where: { id: consultationId }, data: { title, titleSource: "USER" } });
  }

  /** An AI-generated (or provisional) title. Conditional, so it can never overwrite a title the
   * user set — including one renamed while this title was still being generated. True if saved. */
  static async saveGeneratedTitle(consultationId: string, title: string, source: "AUTO" | "PROVISIONAL"): Promise<boolean> {
    const result = await prisma.consultation.updateMany({
      where: { id: consultationId, OR: [{ titleSource: null }, { titleSource: { in: ["AUTO", "PROVISIONAL"] } }] },
      data: { title, titleSource: source },
    });
    return result.count > 0;
  }

  /** The consultation's most recent user messages, oldest first (blank file-only sends skipped). */
  static async listRecentUserMessageContents(consultationId: string, limit: number): Promise<string[]> {
    const rows = await prisma.message.findMany({
      where: { consultationId, role: "user", NOT: { content: "" } },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { content: true },
    });
    return rows.map((row) => row.content).reverse();
  }

  /** Restoring (ACTIVE) also cancels any deletion scheduled for it. */
  static async setConsultationStatus(consultationId: string, status: Exclude<ConsultationStatus, "FOR_DELETION">) {
    return prisma.consultation.update({
      where: { id: consultationId },
      data:
        status === "ARCHIVED"
          ? { status, archivedAt: new Date() }
          : { status, archivedAt: null, deletionRequestedAt: null },
    });
  }

  /** ARCHIVED → FOR_DELETION, starting the grace period. */
  static async requestConsultationDeletion(consultationId: string, requestedAt: Date) {
    return prisma.consultation.update({
      where: { id: consultationId },
      data: { status: "FOR_DELETION", deletionRequestedAt: requestedAt },
    });
  }

  /** One page of FOR_DELETION consultations that entered it at or before `cutoff` — due for
   * ConsultationDeletionQueue. The status check means a restore that raced the sweep wins.
   * Keyset-paged by id (`afterId` = the last id of the previous page), not skip/offset or Prisma's
   * `cursor`: the caller deletes rows between pages, which would shift an offset past rows not yet
   * seen, and a `cursor` must point at a row that still exists. */
  static async findConsultationsDueForDeletion(cutoff: Date, { afterId, take = 100 }: { afterId?: string; take?: number } = {}) {
    return prisma.consultation.findMany({
      where: {
        status: "FOR_DELETION",
        deletionRequestedAt: { lte: cutoff },
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: "asc" },
      take,
      select: { id: true },
    });
  }

  /**
   * Deletes the Consultation for good — ConsultationDeletionQueue's job once the grace period
   * has passed; nothing calls it straight from a request. Its messages and everything keyed to them (Topics, mind
   * maps, audio overview and generated-document rows, ...) go by cascade. Two things wouldn't:
   *  - Documents uploaded into this chat alone (no Case) only lose their consultationId
   *    (onDelete: SetNull) and would linger, reachable from nowhere — deleted here explicitly.
   *    A chat upload that went to the Case stays with the Case.
   *  - S3 objects are never removed inline: their File rows are flagged FOR_DELETION (with
   *    deletedAt) for the cleanup sweep, same as FilesRepo.markForDeletion — unless another
   *    Document still points at the same File.
   * Transcriptions linked to it keep living on the Transcription page (onDelete: SetNull).
   */
  static async deleteConsultationPermanently(consultationId: string) {
    return prisma.$transaction(async (tx) => {
      const [chatOnlyDocuments, audioOverviews, generatedDocuments] = await Promise.all([
        tx.document.findMany({ where: { consultationId, caseId: null }, select: { id: true, fileId: true } }),
        tx.messageAudioOverview.findMany({
          where: { message: { consultationId }, audioFileId: { not: null } },
          select: { audioFileId: true },
        }),
        tx.messageGeneratedDocument.findMany({ where: { message: { consultationId } }, select: { fileId: true } }),
      ]);

      await tx.document.deleteMany({ where: { id: { in: chatOnlyDocuments.map((d) => d.id) } } });
      await tx.consultation.delete({ where: { id: consultationId } });

      const fileIds = new Set<string>([
        ...chatOnlyDocuments.flatMap((d) => (d.fileId ? [d.fileId] : [])),
        ...audioOverviews.flatMap((a) => (a.audioFileId ? [a.audioFileId] : [])),
        ...generatedDocuments.map((g) => g.fileId),
      ]);
      if (fileIds.size === 0) return { filesMarkedForDeletion: 0 };
      const stillReferenced = await tx.document.findMany({
        where: { fileId: { in: [...fileIds] } },
        select: { fileId: true },
      });
      for (const { fileId } of stillReferenced) if (fileId) fileIds.delete(fileId);
      const { count } = await tx.file.updateMany({
        where: { id: { in: [...fileIds] } },
        data: { fileStatus: "FOR_DELETION", deletedAt: new Date() },
      });
      return { filesMarkedForDeletion: count };
    });
  }

  static async listMessagesByConsultation(consultationId: string) {
    return prisma.message.findMany({
      where: { consultationId },
      orderBy: { createdAt: "asc" },
      include: {
        timeline: true,
        mindMap: true,
        relatedCases: true,
        // Present only once the background ranking has run (see CitationRankSvc); links with no
        // entry render neutral.
        citationRanking: true,
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
    const created = await prisma.message.create({
      data: { consultationId, role, content, userId, parentMessageId, groupId, groupOrder, groupTitle, replyStatus },
    });
    // A user turn in a case's chat is activity on that case — bump its "Last updated". Filtered
    // through the consultation relation so this needs no extra lookup; a standalone (non-case)
    // consultation matches no Case row and is a no-op. Assistant/system rows are follow-ons to a
    // user turn and don't need their own bump.
    if (role === "user") {
      const now = new Date();
      prisma.case
        .updateMany({
          where: { consultations: { some: { id: consultationId } }, updatedAt: { lt: new Date(now.getTime() - 60_000) } },
          data: { updatedAt: now },
        })
        .catch(() => {
          // Cosmetic timestamp — never fail the message write over it.
        });
    }
    return created;
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

  /** True when this consultation's most recent message is a user turn still awaiting its reply.
   * Every turn in a consultation shares one Chat Wonder session (see ChatSvc.resolveChatWonderSession)
   * — two turns generating concurrently on it silently orphan one of them, so enqueueChatGeneration
   * checks this before creating a second turn. A best-effort guard (read-then-create, not an
   * atomic lock) layered under the client's own busy check, not a replacement for it. */
  static async hasPendingTurn(consultationId: string): Promise<boolean> {
    const last = await prisma.message.findFirst({
      where: { consultationId },
      orderBy: { createdAt: "desc" },
      select: { role: true, replyStatus: true },
    });
    return last?.role === "user" && last.replyStatus === "PENDING";
  }

  /** Turns that have been PENDING longer than is ever legitimate (attachment wait +
   * generation) — swept back to FAILED by ChatGenerationQueue's own sweep loop so a turn that
   * got silently orphaned (two concurrent turns colliding on one Chat Wonder session, a worker
   * that crashed before reaching its own catch block, a hung Chat Wonder connection that never
   * sends a terminal frame) doesn't leave the client's "still generating" state waiting on an
   * event that will never come. */
  static async findStalePendingMessages(olderThan: Date) {
    return prisma.message.findMany({
      where: { role: "user", replyStatus: "PENDING", createdAt: { lt: olderThan } },
      select: { id: true, consultationId: true, userId: true },
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

  /** Every assistant message of one turn: a single row for an ordinary reply, several siblings
   * under one MessageGroup for a split multi-topic answer. */
  static async findAssistantRepliesByParent(parentMessageId: string) {
    return prisma.message.findMany({
      where: { parentMessageId, role: "assistant" },
      orderBy: { createdAt: "asc" },
      select: { id: true, content: true },
    });
  }

  /** The user's own text for a turn, for ranking citations against what they asked. */
  static async findUserMessageContent(messageId: string) {
    const row = await prisma.message.findUnique({ where: { id: messageId }, select: { content: true } });
    return row?.content ?? null;
  }

  /** Upsert, not create: a re-rank (calibration, a retried job) replaces the old result. */
  static async saveCitationRanking(messageId: string, items: unknown[]) {
    const data = items as unknown as Prisma.InputJsonValue;
    return prisma.messageCitationRanking.upsert({
      where: { messageId },
      create: { messageId, items: data },
      update: { items: data },
    });
  }

  static async findMessageById(messageId: string) {
    return prisma.message.findUnique({
      where: { id: messageId },
      include: { timeline: true, mindMap: true, relatedCases: true, reasoning: true },
    });
  }

  /** Lean id/content/parent lookup for several messages at once — used by CaseSnapshotSvc to
   * resolve DecisionRecord.sourceMessageId (the assistant reply) back to the user prompt that
   * triggered it, for grouping decisions by turn without an N+1 query per record. */
  static async findManyByIds(messageIds: string[]) {
    if (!messageIds.length) return [];
    return prisma.message.findMany({
      where: { id: { in: messageIds } },
      select: { id: true, content: true, parentMessageId: true, consultationId: true, createdAt: true },
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

  /** Rewrites a message's stored Decision Records - used to persist the cleaned-up form
   * (file names instead of ids, re-verified quotes) once ChatSvc has produced it at read time. */
  static async updateDecisionRecords(messageId: string, data: DecisionRecordsPayload) {
    return prisma.messageDecisionRecord.update({
      where: { messageId },
      data: { records: data.records as unknown as Prisma.InputJsonValue },
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

  /**
   * The assistant reply for the most recently *submitted* turn — not the most recently
   * *finished* one. Ordering by the reply's own createdAt (when generation completed) is wrong
   * once two turns for the same consultation can run concurrently (no per-consultation lock
   * exists on the chat-generation queue): a turn asked first can finish generating after a turn
   * asked second, land a later createdAt, and get served as "latest" — surfacing stale Related
   * Cases after a newer prompt. The parent (user) message's createdAt is set synchronously when
   * the request is accepted, before any generation happens, so it tracks true submission order
   * regardless of how long each turn's generation takes. Excludes any assistant row with no
   * parent to order by (shouldn't occur for a normal turn, but would otherwise sort first under
   * Postgres's NULLS FIRST default for DESC).
   */
  static async findLatestAssistantMessage(consultationId: string) {
    return prisma.message.findFirst({
      where: { consultationId, role: "assistant", parentMessageId: { not: null } },
      orderBy: { parent: { createdAt: "desc" } },
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

  /** An overview the case analysis wrote — no chat message behind it (see MessageAudioOverview). */
  static async saveCaseAudioOverview(caseId: string, turns: AudioOverviewTurn[], voiceHostA: string, voiceHostB: string) {
    return prisma.messageAudioOverview.create({
      data: { caseId, turns: turns as unknown as Prisma.InputJsonValue, voiceHostA, voiceHostB },
    });
  }

  /** Looks a row up by its id, or by the chat message it belongs to — the render queue's messages
   * carried a message id before case-owned overviews existed, and one may still be in flight. */
  static async findAudioOverviewByKey(key: string) {
    return prisma.messageAudioOverview.findFirst({
      where: { OR: [{ id: key }, { messageId: key }] },
      include: { audioFile: true },
    });
  }

  /** The case's newest overview from either owner: written by the case analysis, or asked for in
   * one of the case's consultations. */
  static async findLatestAudioOverviewForCase(caseId: string) {
    return prisma.messageAudioOverview.findFirst({
      where: ChatRepo.caseAudioOverviewWhere(caseId),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: { audioFile: true, message: { select: { id: true, consultationId: true } } },
    });
  }

  /** One overview, only if it belongs to the case (either owner). */
  static async findCaseAudioOverview(caseId: string, id: string) {
    return prisma.messageAudioOverview.findFirst({
      where: { AND: [{ id }, ChatRepo.caseAudioOverviewWhere(caseId)] },
      include: { audioFile: true, message: { select: { id: true, consultationId: true } } },
    });
  }

  private static caseAudioOverviewWhere(caseId: string): Prisma.MessageAudioOverviewWhereInput {
    return { OR: [{ caseId }, { message: { consultation: { caseId } } }] };
  }

  static async findAudioOverviewByMessageId(messageId: string) {
    return prisma.messageAudioOverview.findUnique({
      where: { messageId },
      include: { audioFile: true },
    });
  }

  static async saveAudioOverviewChecks(messageId: string, checks: unknown[]) {
    return prisma.messageAudioOverview.update({
      where: { messageId },
      data: { checks: checks as Prisma.InputJsonValue },
    });
  }

  static async saveAudioOverviewChecksById(id: string, checks: unknown[]) {
    return prisma.messageAudioOverview.update({
      where: { id },
      data: { checks: checks as Prisma.InputJsonValue },
    });
  }

  /** A case's Audio Overviews, newest first — the history list: the ones the case analysis wrote
   * and the ones asked for in any of its consultations. Same cursor convention (and `id`
   * tiebreaker) as CaseBriefExportRepo.listByCase. */
  static async listAudioOverviewsByCase(caseId: string, filters: { limit?: number; cursor?: string } = {}) {
    return prisma.messageAudioOverview.findMany({
      where: ChatRepo.caseAudioOverviewWhere(caseId),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: { audioFile: true, message: { select: { id: true, consultationId: true } } },
      take: filters.limit ?? 20,
      ...(filters.cursor && { cursor: { id: filters.cursor }, skip: 1 }),
    });
  }

  /** Keyed by the row id — the one path both chat-made and case-owned overviews render through. */
  static async updateAudioOverviewAudio(
    id: string,
    data: {
      audioFileId?: string;
      audioStatus?: AudioOverviewStatus;
      turnTimings?: number[];
      sentenceTimings?: MarkTiming[][];
      wordTimings?: MarkTiming[][];
    },
  ) {
    const { turnTimings, sentenceTimings, wordTimings, ...rest } = data;
    return prisma.messageAudioOverview.update({
      where: { id },
      data: {
        ...rest,
        ...(turnTimings && { turnTimings: turnTimings as unknown as Prisma.InputJsonValue }),
        ...(sentenceTimings && { sentenceTimings: sentenceTimings as unknown as Prisma.InputJsonValue }),
        ...(wordTimings && { wordTimings: wordTimings as unknown as Prisma.InputJsonValue }),
      },
    });
  }

  /** Re-queued on server start by AudioOverviewQueue — rows a prior process left stuck
   * mid-render (crash/redeploy) rather than ever reaching COMPLETED/FAILED. */
  static async listInProgressAudioOverviews() {
    return prisma.messageAudioOverview.findMany({
      where: { audioStatus: "IN_PROGRESS" },
      select: { id: true },
    });
  }
}
