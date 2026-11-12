import prisma from "../lib/prisma";
import { IntakeMessageRole, IntakeMessageReplyStatus } from "@prisma/client";
import { openIntakeMessage, openIntakeMessages, sealIntakeMessageContent, sealIntakePendingReply } from "../utils/intake-message-content";

/** Stable 32-bit key for a case id, for the advisory lock below — same idiom as cron-lock.ts's
 * lockKey, duplicated rather than imported since that one hashes a job name, not a case id, and
 * the two locks are never meant to collide by sharing a keyspace. */
function lockKeyFor(caseId: string): number {
  let hash = 0;
  for (let i = 0; i < caseId.length; i++) hash = (Math.imul(hash, 31) + caseId.charCodeAt(i)) | 0;
  return hash;
}

/** The intake chat's own repository — reads and writes IntakeMessage only, never Message/
 * Consultation. No groups, no timeline/mindMap/citation side-tables, no Jev message-triage
 * columns: those are lawyer-Terminal concerns this pipeline doesn't carry. Mirrors ChatRepo's
 * shape where the concept genuinely applies (pending-turn guard, stale-pending sweep, streaming
 * checkpoint, cancellation) as its own, separate code — see intake-field-crypto.ts's doc comment
 * for why duplication here is deliberate, not an oversight. */
export default class IntakeChatRepo {
  static async listByCase(caseId: string) {
    const rows = await prisma.intakeMessage.findMany({
      where: { caseId },
      orderBy: { createdAt: "asc" },
    });
    return openIntakeMessages(rows);
  }

  static async createMessage(
    caseId: string,
    role: IntakeMessageRole,
    content: string,
    userId?: string,
    documentIds?: string[],
    replyStatus?: IntakeMessageReplyStatus,
    parentMessageId?: string,
  ) {
    const stored = await prisma.intakeMessage.create({
      data: { caseId, role, content: sealIntakeMessageContent(content), userId, documentIds: documentIds ?? [], replyStatus, parentMessageId },
    });
    return openIntakeMessage(stored) ?? stored;
  }

  /** The SQS-redelivery idempotency guard, same idiom as ChatRepo.findAssistantReplyByParent: a
   * worker retried after a crash checks for an existing reply by parentMessageId before creating
   * a second one. */
  static async findAssistantReplyByParent(parentMessageId: string) {
    return prisma.intakeMessage.findFirst({ where: { parentMessageId, role: "assistant" }, select: { id: true } });
  }

  /** True when this case's most recent intake turn is a user turn still awaiting its reply — the
   * intake pipeline's own one-turn-at-a-time guard, same reasoning as ChatRepo.hasPendingTurn: one
   * Chat Wonder session per case, two turns generating concurrently on it would silently orphan
   * one of them. Not safe against two near-simultaneous callers both passing this check before
   * either's insert lands — see createUserMessageIfNoPendingTurn below for the atomic version
   * enqueueIntakeGeneration actually uses. */
  static async hasPendingTurn(caseId: string): Promise<boolean> {
    const last = await prisma.intakeMessage.findFirst({
      where: { caseId },
      orderBy: { createdAt: "desc" },
      select: { role: true, replyStatus: true },
    });
    return last?.role === "user" && last.replyStatus === "PENDING";
  }

  /** The check-then-insert hasPendingTurn + createMessage would otherwise be, made atomic: a
   * Postgres transaction-scoped advisory lock, keyed by caseId, so two near-simultaneous sends
   * for the same case can't both read "nothing pending" before either's insert lands — the second
   * caller's check, inside the same lock, now sees the first's row. Returns null (same meaning as
   * hasPendingTurn returning true) when another turn is already pending; the created message
   * otherwise. */
  static async createUserMessageIfNoPendingTurn(
    caseId: string,
    content: string,
    userId: string,
    documentIds?: string[],
    audioKey?: string,
  ) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKeyFor(caseId)})`;
      const last = await tx.intakeMessage.findFirst({
        where: { caseId },
        orderBy: { createdAt: "desc" },
        select: { role: true, replyStatus: true },
      });
      if (last?.role === "user" && last.replyStatus === "PENDING") return null;
      const stored = await tx.intakeMessage.create({
        data: { caseId, role: "user", content: sealIntakeMessageContent(content), userId, documentIds: documentIds ?? [], replyStatus: "PENDING", audioKey },
      });
      return openIntakeMessage(stored) ?? stored;
    });
  }

  /** Overwrites a voice turn's placeholder content with its transcript once Amazon Transcribe
   * finishes — the one write IntakeChatSvc.runIntakeGenerationJob does before generation starts. */
  static async setTranscribedContent(messageId: string, transcript: string) {
    const stored = await prisma.intakeMessage.update({
      where: { id: messageId },
      data: { content: sealIntakeMessageContent(transcript) },
    });
    return openIntakeMessage(stored) ?? stored;
  }

  /** Stamps a voice turn's assistant reply with its synthesized audio's S3 key, called before
   * chat:done fires so the event always means "everything, including audio, is ready". */
  static async setReplyAudio(messageId: string, audioKey: string) {
    return prisma.intakeMessage.update({
      where: { id: messageId },
      data: { replyAudioKey: audioKey },
    });
  }

  /** Turns that have been PENDING longer than is ever legitimate — swept to FAILED (and refunded) by the
   * intake queue's own stale-sweep (intake-chat-generation.queue.ts), never the lawyer/client
   * queues' unified one. */
  static async findStalePending(olderThan: Date) {
    return prisma.intakeMessage.findMany({
      where: { role: "user", replyStatus: "PENDING", createdAt: { lt: olderThan } },
      select: { id: true, caseId: true, userId: true },
    });
  }

  /** A user turn's current replyStatus (and its checkpointed partial reply) — polled by the
   * generation worker to notice a Stop from another instance, and read by the cancel endpoint. */
  static async findReplyState(messageId: string) {
    const row = await prisma.intakeMessage.findUnique({
      where: { id: messageId },
      select: { id: true, caseId: true, role: true, userId: true, replyStatus: true, pendingReplyContent: true },
    });
    return row ? openIntakeMessage(row) : row;
  }

  /** Ends a turn that never got its full answer (Stop, or a failure) and gives the client back the
   * credit it cost — PENDING -> CANCELLED/FAILED and the refund in ONE transaction, the status
   * flip conditional on the turn still being PENDING. Whoever ends the turn first (Stop, the
   * worker, the stale sweep) wins; everyone after gets false and refunds nothing, so a turn is
   * refunded at most once. */
  static async endPendingTurn(messageId: string, caseId: string, status: "FAILED" | "CANCELLED"): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.intakeMessage.updateMany({
        where: { id: messageId, caseId, role: "user", replyStatus: "PENDING" },
        data: { replyStatus: status, pendingReplyContent: null },
      });
      if (count !== 1) return false;
      await tx.case.update({ where: { id: caseId }, data: { clientCredits: { increment: 1 } } });
      return true;
    });
  }

  /** Saves the answer and marks its turn DONE in one transaction — only while the turn is still
   * PENDING. Null when the turn was already stopped or failed (and refunded): that answer is
   * dropped, so a late worker never delivers an answer the client got their credit back for. */
  static async completeTurn(parentMessageId: string, caseId: string, content: string) {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.intakeMessage.updateMany({
        where: { id: parentMessageId, caseId, role: "user", replyStatus: "PENDING" },
        data: { replyStatus: "DONE", pendingReplyContent: null },
      });
      if (count !== 1) return null;
      const stored = await tx.intakeMessage.create({
        data: { caseId, role: "assistant", content: sealIntakeMessageContent(content), documentIds: [], parentMessageId },
      });
      return openIntakeMessage(stored) ?? stored;
    });
  }

  /** One message of a case's chat, for deleting it — null when it isn't in that case. */
  static async findInCase(messageId: string, caseId: string) {
    return prisma.intakeMessage.findFirst({
      where: { id: messageId, caseId },
      select: { id: true, role: true, replyStatus: true },
    });
  }

  /** Deletes a message and, for a user turn, the answers to it (parentMessageId only SETs NULL on
   * delete, so they'd otherwise be left behind). Returns the S3 audio the deleted rows pointed to,
   * so the caller can remove it too. */
  static async deleteTurn(messageId: string, caseId: string): Promise<string[]> {
    return prisma.$transaction(async (tx) => {
      const rows = await tx.intakeMessage.findMany({
        where: { caseId, OR: [{ id: messageId }, { parentMessageId: messageId }] },
        select: { id: true, audioKey: true, replyAudioKey: true },
      });
      if (!rows.length) return [];
      await tx.intakeMessage.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      return rows.flatMap((r) => [r.audioKey, r.replyAudioKey]).filter((k): k is string => Boolean(k));
    });
  }

  /** Checkpoints the raw accumulated reply text while a turn is still streaming — throttled by the
   * caller, not on every chunk. */
  static async checkpointPendingReply(messageId: string, pendingReplyContent: string) {
    const stored = await prisma.intakeMessage.update({ where: { id: messageId }, data: { pendingReplyContent: sealIntakePendingReply(pendingReplyContent) } });
    return openIntakeMessage(stored) ?? stored;
  }

  /** find_lawyer's returned ids, landing on the assistant turn that produced them (see
   * [LAWYER_MATCHES] frame handling in IntakeChatSvc). */
  static async recordFindLawyerResult(messageId: string, lawyerIds: string[]) {
    return prisma.intakeMessage.update({ where: { id: messageId }, data: { findLawyerResultIds: lawyerIds } });
  }

  /** mark_case_ready firing on this turn (see [CASE_READY] frame handling). */
  static async markReady(messageId: string) {
    return prisma.intakeMessage.update({ where: { id: messageId }, data: { markedReady: true } });
  }
}
