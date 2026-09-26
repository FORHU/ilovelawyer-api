import ChatSvc from "../services/chat.service";
import ChatRepo from "../repositories/chat.repository";
import { emitToUser } from "../lib/socket";
import { sendMessage, receiveMessages, deleteMessage, withVisibilityHeartbeat } from "../lib/sqs";
import { MESSAGE_PERSISTENCE_QUEUE_URL } from "../config";
import { TenantCode } from "../types/tenant-code";
import logger from "../utils/logger";

/**
 * Everything ChatSvc.processChatGenerationJob needs to run a chat turn's full AI generation
 * lifecycle (RAG, cache check, AI streaming, checkpointing, canonical persistence) OWNED BY
 * THE WORKER — not by the original HTTP request. ChatCtrl.sendMessage no longer does any of
 * this itself: it validates the request, creates the user Message row (PENDING — this row's id
 * doubles as `jobId`, there's no separate job table), enqueues this job, and returns
 * `{ messageId, sessionId, replyStatus: "PENDING" }` immediately. The browser connection the
 * request arrived on has no bearing on whether this job runs to completion.
 */
export interface ChatGenerationJob {
  /** The user Message's id — the durable job record. There's no separate AiJob row: the
   * existing Message.replyStatus (PENDING/DONE/FAILED) and pendingReplyContent checkpoint
   * ARE the job's status/progress, exactly as they were before this turn was queue-driven. */
  jobId: string;
  organizationId: string;
  tenantCode: TenantCode;
  userId: string;
  consultationId: string;
  /** Resolved at enqueue time (ChatSvc.enqueueChatGeneration) via the same redis-cached
   * resolveChatWonderSession used before this refactor — cheap in the common case (no Chat
   * Wonder network call unless this is the consultation's very first turn). The worker can
   * still rotate it mid-job (streamWithSessionRetry's "Unknown session" path) and push the
   * rotation to a connected client via the chat:session-rotated socket event. */
  sessionId: string;
  userInput: string;
  documentContext?: string;
  /** Explicit single-document scoping for RAG ranking — resolved/ownership-checked inside the
   * worker (ChatSvc.scopedCaseDocumentId), same as before this refactor; it's a RAG concern,
   * not a job-creation concern, so it isn't pre-resolved at enqueue time like effectiveCaseId
   * below. */
  caseDocumentId?: string;
  /** Already resolved (consultation.caseId, or the client-supplied caseId after an ownership
   * check) at enqueue time — a bad/foreign caseId 404s immediately in the request instead of
   * surfacing only after a round trip through SQS. */
  effectiveCaseId: string | null;
  enqueuedAt?: number;
}

// Each job is normally one Chat Wonder call (occasionally two, on an "Unknown session" retry) —
// the same shape as AiGenerationQueue's jobs, just for ordinary chat turns instead of lawyer-
// triggered case actions. Long enough to comfortably cover a slow reply; withVisibilityHeartbeat
// keeps renewing on an interval for as long as the job is actually running, so this only has to
// outlast the gap before the first renewal, not the whole job.
const VISIBILITY_TIMEOUT_SECONDS = 300;
// Chat is the primary, highest-volume interactive feature (unlike the occasional Refresh/Red
// Team actions on AiGenerationQueue) — I/O-bound (WebSocket to Chat Wonder), not CPU/memory
// heavy, so a higher concurrency keeps response latency reasonable under load.
const CONCURRENCY = 10;

// Generous ceiling for a turn to legitimately still be PENDING — ChatSvc.processChatGenerationJob
// can itself wait up to ATTACHMENT_READY_MAX_WAIT_MS (10 min) before generation even starts, on
// top of however long Chat Wonder actually takes. Past this, a turn is almost certainly orphaned
// (see findStalePendingMessages's doc comment), not just slow — swept below rather than left to
// hang on an event that's never coming. Checked on a slower cadence since it's a safety net, not
// a latency-sensitive path.
const STALE_PENDING_CEILING_MS = 15 * 60_000;
const SWEEP_INTERVAL_MS = 2 * 60_000;

interface WaitItem {
  job: ChatGenerationJob;
  /** null for the enqueue-failed in-memory fallback — nothing to delete/ack for those. */
  receiptHandle: string | null;
  /** The SQS-assigned id this job was delivered under — undefined for the same in-memory
   * fallback cases as receiptHandle. Logged alongside job.jobId throughout so a job's whole
   * lifecycle (enqueued -> received -> started -> finished -> acked) can be traced by either id. */
  sqsMessageId?: string;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SQS queue that OWNS a chat turn's AI generation from RAG through canonical persistence —
 * the queue-driven architecture this replaces ChatSvc.sendMessage's old "do everything
 * synchronously in the request, then enqueue only the DB write" design with (see
 * ChatSvc.enqueueChatGeneration / ChatSvc.processChatGenerationJob).
 *
 * Queue URL: reuses MESSAGE_PERSISTENCE_QUEUE_URL — the one that used to be where the chat
 * message itself got persisted, before this turn was queue-driven (see that config constant's
 * doc comment). This is the ONLY consumer of that queue; CaseGraphPromotionQueue has its own,
 * separate CASE_GRAPH_PROMOTION_QUEUE_URL. Never point two queue classes' consumers at the
 * same physical SQS queue — each poller has no way to tell "not my message type" from
 * "malformed," so they'll randomly steal and drop each other's jobs.
 *
 * Acking: unlike CaseGraphPromotionQueue (which leaves a failed job un-acked so SQS blindly
 * redelivers it), this queue ALWAYS acks in `runOne`'s `finally`, mirroring AiGenerationQueue's
 * established pattern for the same reason — Message.replyStatus is this job's own durable
 * status record (set to DONE or FAILED by processChatGenerationJob itself), so a "controlled"
 * failure doesn't need SQS to blindly retry a whole new Chat Wonder call against a prompt that
 * already failed. A genuine WORKER CRASH (the process dying before reaching the ack) is the
 * one case SQS's redelivery is actually relied on for — the message was never acked, so it
 * reappears after VISIBILITY_TIMEOUT_SECONDS and a healthy worker picks it up fresh.
 * ChatSvc.persistAssistantTurn's idempotency guard (findAssistantReplyByParent) makes that
 * redelivery safe even if the crash happened after the assistant message was already created.
 */
export default class ChatGenerationQueue {
  private static running = false;
  private static active = 0;
  private static memoryWait: WaitItem[] = [];

  static enqueue(job: ChatGenerationJob): void {
    if (!job?.jobId) return;
    job.enqueuedAt = job.enqueuedAt ?? Date.now();

    sendMessage(MESSAGE_PERSISTENCE_QUEUE_URL, JSON.stringify(job))
      .catch((err) => {
        logger.error("Failed to enqueue chat generation job — falling back to in-process", {
          err,
          jobId: job.jobId,
          consultationId: job.consultationId,
        });
        // Never drop a turn the user is actively waiting on. If the worker loop is running,
        // hand it to memoryWait so the CONCURRENCY cap still applies; if the queue never
        // started (no URL configured), run it inline right here.
        if (this.running) {
          logger.warn("Chat generation: SQS send failed, queued in-process instead", { jobId: job.jobId });
          this.memoryWait.push({ job, receiptHandle: null });
          this.pump();
        } else {
          logger.warn("Chat generation: queue not running, processing this job fully inline", { jobId: job.jobId });
          void ChatSvc.processChatGenerationJob(job).catch((e) => {
            logger.error("Chat generation: inline fallback failed", {
              err: e,
              jobId: job.jobId,
              consultationId: job.consultationId,
            });
          });
        }
      });
  }

  static start(): void {
    if (this.running) return;
    if (!MESSAGE_PERSISTENCE_QUEUE_URL) {
      logger.error("Chat generation queue: MESSAGE_PERSISTENCE_QUEUE_URL is not set, refusing to start");
      return;
    }
    this.running = true;
    void this.run();
  }

  private static async run(): Promise<void> {
    void this.fetchLoop();
    void this.sweepLoop();
    this.pump();
  }

  /** Independent of fetchLoop/pump on purpose: a turn stuck because ITS OWN worker hung (the
   * exact failure mode this exists to catch) would never notice its own staleness — this has
   * to be a separate loop that doesn't depend on any one job's promise ever settling. */
  private static async sweepLoop(): Promise<void> {
    while (this.running) {
      await sleep(SWEEP_INTERVAL_MS);
      try {
        await this.sweepStalePending();
      } catch (err) {
        logger.error("Chat generation: stale-pending sweep failed", { err });
      }
    }
  }

  private static async sweepStalePending(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_PENDING_CEILING_MS);
    const stale = await ChatRepo.findStalePendingMessages(cutoff);
    if (stale.length === 0) return;

    logger.warn("Chat generation: sweeping stale PENDING turns to FAILED", {
      count: stale.length,
      messageIds: stale.map((m) => m.id),
    });

    for (const message of stale) {
      try {
        await ChatRepo.setReplyStatus(message.id, "FAILED", { clearPendingContent: true });
        if (message.userId) {
          emitToUser(message.userId, "chat:error", {
            consultationId: message.consultationId,
            messageId: message.id,
            message: "Generation timed out",
          });
        }
      } catch (err) {
        logger.error("Chat generation: failed to sweep stale PENDING turn", { err, messageId: message.id });
      }
    }
  }

  private static async fetchLoop(): Promise<void> {
    while (this.running) {
      const available = CONCURRENCY - this.active - this.memoryWait.length;
      if (available <= 0) {
        await sleep(200);
        continue;
      }

      const messages = await receiveMessages(MESSAGE_PERSISTENCE_QUEUE_URL, available, VISIBILITY_TIMEOUT_SECONDS);
      if (messages.length === 0) continue;

      for (const message of messages) {
        const job = this.parse(message.body);
        if (!job) {
          logger.error("Chat generation: dropping malformed SQS message", { sqsMessageId: message.messageId });
          void deleteMessage(MESSAGE_PERSISTENCE_QUEUE_URL, message.receiptHandle).catch(() => {});
          continue;
        }
        this.memoryWait.push({ job, receiptHandle: message.receiptHandle, sqsMessageId: message.messageId });
      }
      this.pump();
    }
  }

  private static parse(body: string): ChatGenerationJob | null {
    let parsed: Partial<ChatGenerationJob> | undefined;
    try {
      parsed = JSON.parse(body) as Partial<ChatGenerationJob>;
    } catch (err) {
      logger.error("Chat generation queue: message body is not valid JSON", { err, body });
      return null;
    }
    if (
      parsed &&
      typeof parsed.jobId === "string" &&
      typeof parsed.consultationId === "string" &&
      typeof parsed.organizationId === "string" &&
      typeof parsed.userId === "string" &&
      typeof parsed.sessionId === "string" &&
      typeof parsed.userInput === "string"
    ) {
      return parsed as ChatGenerationJob;
    }
    // Valid JSON but the wrong shape — most likely MESSAGE_PERSISTENCE_QUEUE_URL got pointed at
    // a queue another consumer is also polling (see the class doc comment on why that's unsafe).
    // Logging the keys actually present, not the full body, makes that misconfiguration obvious
    // without dumping potentially large chat payloads into the log.
    logger.error("Chat generation queue: message JSON doesn't match ChatGenerationJob's shape", {
      keysPresent: parsed ? Object.keys(parsed) : [],
    });
    return null;
  }

  private static pump(): void {
    if (!this.running) return;

    while (this.active < CONCURRENCY && this.memoryWait.length > 0) {
      const item = this.memoryWait.shift();
      if (!item) break;
      this.runOne(item);
    }
  }

  private static runOne(item: WaitItem): void {
    this.active += 1;
    const startedAt = Date.now();
    void withVisibilityHeartbeat(MESSAGE_PERSISTENCE_QUEUE_URL, item.receiptHandle, VISIBILITY_TIMEOUT_SECONDS, () =>
      ChatSvc.processChatGenerationJob(item.job),
    )
      // processChatGenerationJob already records FAILED on the Message row and emits
      // chat:error before rethrowing — this catch only stops the rejection from going
      // unhandled; see the class doc comment for why this queue always acks regardless.
      .catch((err) => {
        logger.error("Chat generation: job failed", {
          err,
          jobId: item.job.jobId,
          consultationId: item.job.consultationId,
          sqsMessageId: item.sqsMessageId,
          durationMs: Date.now() - startedAt,
        });
      })
      .finally(async () => {
        if (item.receiptHandle) {
          await deleteMessage(MESSAGE_PERSISTENCE_QUEUE_URL, item.receiptHandle)
            .catch((err) => {
              logger.error("Chat generation queue: failed to delete message", {
                err,
                jobId: item.job.jobId,
                sqsMessageId: item.sqsMessageId,
              });
            });
        }
        this.active -= 1;
        this.pump();
      });
  }
}
