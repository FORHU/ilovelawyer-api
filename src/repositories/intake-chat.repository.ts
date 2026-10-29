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

  /** Flips a user turn's replyStatus once its reply is known to be done or has failed — same
   * purpose as ChatRepo.setReplyStatus. */
  static async setReplyStatus(messageId: string, replyStatus: IntakeMessageReplyStatus, opts?: { clearPendingContent?: boolean }) {
    const stored = await prisma.intakeMessage.update({
      where: { id: messageId },
      data: { replyStatus, ...(opts?.clearPendingContent ? { pendingReplyContent: null } : {}) },
    });
    return openIntakeMessage(stored) ?? stored;
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
  static async createUserMessageIfNoPendingTurn(caseId: string, content: string, userId: string, documentIds?: string[]) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKeyFor(caseId)})`;
      const last = await tx.intakeMessage.findFirst({
        where: { caseId },
        orderBy: { createdAt: "desc" },
        select: { role: true, replyStatus: true },
      });
      if (last?.role === "user" && last.replyStatus === "PENDING") return null;
      const stored = await tx.intakeMessage.create({
        data: { caseId, role: "user", content: sealIntakeMessageContent(content), userId, documentIds: documentIds ?? [], replyStatus: "PENDING" },
      });
      return openIntakeMessage(stored) ?? stored;
    });
  }

  /** Turns that have been PENDING longer than is ever legitimate — swept back to FAILED by the
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

  /** PENDING -> CANCELLED as ONE conditional write, so a Stop racing the worker's own DONE/FAILED
   * flip has exactly one winner. */
  static async markReplyCancelled(messageId: string, caseId: string): Promise<boolean> {
    const { count } = await prisma.intakeMessage.updateMany({
      where: { id: messageId, caseId, role: "user", replyStatus: "PENDING" },
      data: { replyStatus: "CANCELLED", pendingReplyContent: null },
    });
    return count === 1;
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
