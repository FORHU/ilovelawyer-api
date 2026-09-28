import ChatSvc from "../services/chat.service";
import { sendMessage, receiveMessages, deleteMessage, withVisibilityHeartbeat } from "../lib/sqs";
import { CASE_GRAPH_PROMOTION_QUEUE_URL } from "../config";
import { TimelineItem, DecisionRecordsPayload } from "../utils/response-parser";
import logger from "../utils/logger";

// A handful of Prisma writes per job (case-timeline promotion, decision-record promotion +
// case-graph edges) — light, so several turns' promotions can run at once. Per-instance, same
// caveat as the other queues.
const CONCURRENCY = 5;
// The real job settles well under a second; this is only a safety margin, renewed well
// before expiry (see withVisibilityHeartbeat).
const VISIBILITY_TIMEOUT_SECONDS = 60;
// In-process retries for jobs that have no SQS receipt to fall back on (the enqueue-failed
// memoryWait items and the no-queue inline path). SQS-delivered jobs don't need this: a failed
// job is simply not acked and SQS redelivers it after the visibility timeout. Backoff is
// 2s, 4s, 8s — long enough to ride out the transient RDS "can't reach database server" blips
// seen on staging, short enough to not pile up work.
const IN_PROCESS_RETRIES = 3;
const IN_PROCESS_RETRY_BASE_MS = 2_000;

/**
 * Everything ChatSvc.promoteAssistantTurnToCaseGraph needs. The canonical assistant Message row
 * (content, timeline/mindMap/audioOverview/reasoning/decisions rows) is already durably
 * persisted by the time this is enqueued — see ChatSvc.processChatGenerationJob, which awaits
 * ChatSvc.persistAssistantTurn before ever enqueueing this. This queue only carries the
 * case-graph *enrichment* derived from that turn (promoting the AI's timeline/decisions into
 * the case's own Timeline/DecisionRecord tables and CaseGraph nodes/edges) — background work
 * whose failure must never affect whether the chat message itself exists.
 */
export interface CaseGraphPromotionPayload {
  consultationId: string;
  /** The user Message this reply answers. */
  parentMessageId: string;
  /** The already-persisted assistant Message (or its last split-topic sibling) — decision
   * records anchor to this as their sourceMessageId; also the idempotency key for this job. */
  assistantMessageId: string;
  effectiveCaseId: string | null;
  userId: string;
  timeline?: TimelineItem[];
  decisions?: DecisionRecordsPayload;
  /** Date.now() at the moment ChatSvc.processChatGenerationJob called enqueue() — lets the
   * queue log how long a job actually waited in SQS before a worker picked it up. */
  enqueuedAt?: number;
}

interface WaitItem {
  payload: CaseGraphPromotionPayload;
  /** null for the enqueue-failed in-memory fallback — nothing to delete/ack for those. */
  receiptHandle: string | null;
  /** The SQS-assigned id this job was delivered under — undefined for the same in-memory
   * fallback cases as receiptHandle. Logged alongside payload.assistantMessageId throughout so a
   * job's whole lifecycle (enqueued -> received -> promoted -> acked) can be traced by either id. */
  sqsMessageId?: string;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SQS queue for the case-graph enrichment that follows an already-persisted chat turn — promoting
 * the AI's timeline/decision-record extras into the case's own graph (CaseTimelineSvc.promoteFromAi,
 * DecisionRecordSvc.promote). This is deliberately NOT where the chat message itself gets created:
 * ChatSvc.processChatGenerationJob (run by ChatGenerationQueue's worker) persists the canonical
 * assistant Message via ChatSvc.persistAssistantTurn before this is ever enqueued. A failure here
 * can never make an already-delivered, already-persisted reply disappear; it only delays
 * case-graph enrichment, which is retried the same way the other queues are (SQS redelivery, or
 * in-process backoff for the enqueue-failed fallback).
 */
export default class CaseGraphPromotionQueue {
  private static running = false;
  private static active = 0;
  private static memoryWait: WaitItem[] = [];

  static enqueue(payload: CaseGraphPromotionPayload): void {
    if (!payload?.assistantMessageId) return;
    // Nothing to promote — skip the round trip through SQS entirely.
    if (!payload.timeline?.length && !payload.decisions?.records.length) return;
    payload.enqueuedAt = payload.enqueuedAt ?? Date.now();

    sendMessage(CASE_GRAPH_PROMOTION_QUEUE_URL, JSON.stringify(payload))
      .catch(async (err) => {
        logger.error("Failed to enqueue case graph promotion job", {
          err,
          parentMessageId: payload.parentMessageId,
          assistantMessageId: payload.assistantMessageId,
        });
        // The chat message is already durable regardless of this failure — never drop the
        // enrichment work either, though. If the worker loop is running, hand it to
        // memoryWait so the CONCURRENCY cap still applies; if the queue never started (no URL
        // configured), promote inline right here.
        if (this.running) {
          this.memoryWait.push({ payload, receiptHandle: null });
          this.pump();
        } else {
          await promoteWithRetry(payload).catch((e) => {
            logger.error("Case graph promotion: inline fallback failed after retries — enrichment lost", {
              err: e,
              parentMessageId: payload.parentMessageId,
              assistantMessageId: payload.assistantMessageId,
              consultationId: payload.consultationId,
            });
          });
        }
      });
  }

  static start(): void {
    if (this.running) return;
    // receiveMessages() swallows its own errors (see lib/sqs.ts) and returns [], so an
    // empty/missing queue URL would make fetchLoop spin on ReceiveMessageCommand with no
    // backoff. Refuse to start instead — matches AiGenerationQueue.
    if (!CASE_GRAPH_PROMOTION_QUEUE_URL) {
      logger.error("Case graph promotion queue: CASE_GRAPH_PROMOTION_QUEUE_URL is not set, refusing to start");
      return;
    }
    this.running = true;
    void this.run();
  }

  private static async run(): Promise<void> {
    void this.fetchLoop();
    this.pump();
  }

  private static async fetchLoop(): Promise<void> {
    while (this.running) {
      const available = CONCURRENCY - this.active - this.memoryWait.length;
      if (available <= 0) {
        await sleep(200);
        continue;
      }

      const messages = await receiveMessages(CASE_GRAPH_PROMOTION_QUEUE_URL, available, VISIBILITY_TIMEOUT_SECONDS);
      if (messages.length === 0) continue;

      for (const message of messages) {
        const payload = this.parse(message.body);
        if (!payload) {
          // Malformed message — drop it rather than let it loop forever.
          logger.error("Case graph promotion: dropping malformed SQS message", { sqsMessageId: message.messageId });
          void deleteMessage(CASE_GRAPH_PROMOTION_QUEUE_URL, message.receiptHandle).catch(() => {});
          continue;
        }
        this.memoryWait.push({ payload, receiptHandle: message.receiptHandle, sqsMessageId: message.messageId });
      }
      this.pump();
    }
  }

  private static parse(body: string): CaseGraphPromotionPayload | null {
    try {
      const parsed = JSON.parse(body) as Partial<CaseGraphPromotionPayload>;
      if (
        parsed &&
        typeof parsed.consultationId === "string" &&
        typeof parsed.parentMessageId === "string" &&
        typeof parsed.assistantMessageId === "string" &&
        typeof parsed.userId === "string"
      ) {
        return parsed as CaseGraphPromotionPayload;
      }
    } catch {
      // fallthrough to the error log below
    }
    logger.error("Case graph promotion queue: malformed message", { body });
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
    // SQS-delivered jobs get one attempt here and rely on redelivery: the message is acked
    // only after promoteAssistantTurnToCaseGraph resolves. A failed job is left un-acked so it
    // reappears after VISIBILITY_TIMEOUT_SECONDS and is retried by whichever instance receives
    // it (the queue's own redrive policy bounds the retries).
    // Jobs without a receipt (enqueue-failed fallback) have nothing to redeliver them, so
    // they retry in-process instead.
    const job = item.receiptHandle
      ? () => ChatSvc.promoteAssistantTurnToCaseGraph(item.payload)
      : () => promoteWithRetry(item.payload);
    void withVisibilityHeartbeat(CASE_GRAPH_PROMOTION_QUEUE_URL, item.receiptHandle, VISIBILITY_TIMEOUT_SECONDS, job)
      .then(async () => {
        if (item.receiptHandle) {
          await deleteMessage(CASE_GRAPH_PROMOTION_QUEUE_URL, item.receiptHandle)
            .catch((err) => {
              // Promoted but not acked: SQS will redeliver. promoteAssistantTurnToCaseGraph's
              // own idempotency guard (see DecisionRecordRepo.existsForSourceMessage) makes
              // that safe rather than a duplicate promotion.
              logger.error("Case graph promotion queue: failed to delete message", {
                err,
                parentMessageId: item.payload.parentMessageId,
                assistantMessageId: item.payload.assistantMessageId,
                sqsMessageId: item.sqsMessageId,
              });
            });
        }
      })
      .catch((err) => {
        logger.error(
          item.receiptHandle
            ? "Case graph promotion queue: job failed — left for SQS redelivery"
            : "Case graph promotion queue: in-process job failed after retries — enrichment lost",
          {
            err,
            parentMessageId: item.payload.parentMessageId,
            assistantMessageId: item.payload.assistantMessageId,
            consultationId: item.payload.consultationId,
            sqsMessageId: item.sqsMessageId,
            processingMs: Date.now() - startedAt,
          },
        );
      })
      .finally(() => {
        this.active -= 1;
        this.pump();
      });
  }
}

/** promoteAssistantTurnToCaseGraph with bounded exponential backoff — for the paths that have no
 * SQS receipt behind them. The chat message itself is never at stake here (it's already
 * persisted); this only retries the case-graph enrichment. */
async function promoteWithRetry(payload: CaseGraphPromotionPayload): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= IN_PROCESS_RETRIES; attempt++) {
    try {
      await ChatSvc.promoteAssistantTurnToCaseGraph(payload);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < IN_PROCESS_RETRIES) {
        const delay = IN_PROCESS_RETRY_BASE_MS * 2 ** attempt;
        logger.warn("Case graph promotion: attempt failed, retrying", {
          err,
          attempt: attempt + 1,
          retryInMs: delay,
          assistantMessageId: payload.assistantMessageId,
        });
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}
