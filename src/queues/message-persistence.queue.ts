import ChatSvc from "../services/chat.service";
import { sendMessage, receiveMessages, deleteMessage, withVisibilityHeartbeat } from "../lib/sqs";
import { MESSAGE_PERSISTENCE_QUEUE_URL } from "../config";
import { RelatedCase } from "../utils/chatWonder";
import { MindMapItem, TimelineItem, AudioOverviewTurn, ReasoningExplanation, DecisionRecordsPayload } from "../utils/response-parser";
import logger from "../utils/logger";

// A handful of Prisma writes per job (create the assistant Message(s), save the structured
// extras) — light, so several turns' saves can run at once. Per-instance, same caveat as the
// other queues.
const CONCURRENCY = 5;
// The real job settles well under a second; this is only a safety margin, renewed well
// before expiry (see withVisibilityHeartbeat).
const VISIBILITY_TIMEOUT_SECONDS = 60;
// In-process retries for jobs that have no SQS receipt to fall back on (the enqueue-failed
// memoryWait items and the no-queue inline path). SQS-delivered jobs don't need this: a failed
// job is simply not acked and SQS redelivers it after the visibility timeout. Backoff is
// 2s, 4s, 8s — long enough to ride out the transient RDS "can't reach database server" blips
// seen on staging, short enough that the reply appears on the next page load.
const IN_PROCESS_RETRIES = 3;
const IN_PROCESS_RETRY_BASE_MS = 2_000;

/** Everything ChatSvc.persistAssistantTurn needs — captured in memory the moment the stream
 * finishes, since there's no assistant Message row to reload it from yet. Serialized straight
 * into the SQS message body. */
export interface AssistantTurnPayload {
  consultationId: string;
  /** The user Message this reply answers — assistant rows hang off it as parentMessageId. */
  parentMessageId: string;
  effectiveCaseId: string | null;
  userId: string;
  /** Raw accumulated reply text — persistAssistantTurn still needs the un-stripped form for
   * stripStructuredBlocks / splitIntoTopics / the extractTimeline+extractMindMap fallback. */
  fullResponse: string;
  relatedCases: RelatedCase[];
  mindMap?: MindMapItem;
  timeline?: TimelineItem[];
  audioOverview?: AudioOverviewTurn[];
  reasoning?: ReasoningExplanation;
  decisions?: DecisionRecordsPayload;
}

interface WaitItem {
  payload: AssistantTurnPayload;
  /** null for the enqueue-failed in-memory fallback — nothing to delete/ack for those. */
  receiptHandle: string | null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SQS queue for persisting a chat turn's assistant reply after it has already streamed to the
 * client. ChatSvc.sendMessage streams the response as today, then enqueues this — the request
 * ends the instant the last token is sent instead of waiting on the topic-split, MessageGroup,
 * timeline/mind-map/audio-overview/reasoning/related-cases writes. Mirrors the other queues'
 * shape (see citation-extraction.queue.ts); durability is SQS's own redelivery — a message
 * received but never deleted (worker crashed mid-save) reappears after its visibility timeout,
 * so ChatSvc.persistAssistantTurn is written to be idempotent.
 */
export default class MessagePersistenceQueue {
  private static running = false;
  private static active = 0;
  private static memoryWait: WaitItem[] = [];

  static enqueue(payload: AssistantTurnPayload): void {
    if (!payload?.parentMessageId) return;

    sendMessage(MESSAGE_PERSISTENCE_QUEUE_URL, JSON.stringify(payload)).catch(async (err) => {
      logger.error("Failed to enqueue assistant turn persistence job", {
        err,
        parentMessageId: payload.parentMessageId,
      });
      // Never drop the turn. If the worker loop is running, hand it to memoryWait so the
      // CONCURRENCY cap still applies; if the queue never started (no URL configured),
      // persist inline right here.
      if (this.running) {
        this.memoryWait.push({ payload, receiptHandle: null });
        this.pump();
      } else {
        await persistWithRetry(payload).catch((e) => {
          logger.error("Message persistence: inline fallback failed after retries — reply lost", {
            err: e,
            parentMessageId: payload.parentMessageId,
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
    if (!MESSAGE_PERSISTENCE_QUEUE_URL) {
      logger.error("Message persistence queue: MESSAGE_PERSISTENCE_QUEUE_URL is not set, refusing to start");
      return;
    }
    this.running = true;
    void this.run();
  }

  private static async run(): Promise<void> {
    logger.info("Message persistence queue started", { concurrency: CONCURRENCY });
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

      const messages = await receiveMessages(MESSAGE_PERSISTENCE_QUEUE_URL, available, VISIBILITY_TIMEOUT_SECONDS);
      if (messages.length === 0) continue;

      for (const message of messages) {
        const payload = this.parse(message.body);
        if (!payload) {
          // Malformed message — drop it rather than let it loop forever.
          void deleteMessage(MESSAGE_PERSISTENCE_QUEUE_URL, message.receiptHandle).catch(() => {});
          continue;
        }
        this.memoryWait.push({ payload, receiptHandle: message.receiptHandle });
      }
      this.pump();
    }
  }

  private static parse(body: string): AssistantTurnPayload | null {
    try {
      const parsed = JSON.parse(body) as Partial<AssistantTurnPayload>;
      if (
        parsed &&
        typeof parsed.consultationId === "string" &&
        typeof parsed.parentMessageId === "string" &&
        typeof parsed.userId === "string" &&
        typeof parsed.fullResponse === "string" &&
        Array.isArray(parsed.relatedCases)
      ) {
        return parsed as AssistantTurnPayload;
      }
    } catch {
      // fallthrough to the error log below
    }
    logger.error("Message persistence queue: malformed message", { body });
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
    // SQS-delivered jobs get one attempt here and rely on redelivery: the message is acked
    // only after persistAssistantTurn resolves. A failed job is left un-acked so it reappears
    // after VISIBILITY_TIMEOUT_SECONDS and is retried by whichever instance receives it (the
    // queue's own redrive policy bounds the retries). Acking in a `finally` regardless of
    // outcome — the previous behaviour — turned one transient DB error into a reply that
    // had streamed to the user but never existed in their history.
    // Jobs without a receipt (enqueue-failed fallback) have nothing to redeliver them, so
    // they retry in-process instead.
    const job = item.receiptHandle
      ? () => ChatSvc.persistAssistantTurn(item.payload)
      : () => persistWithRetry(item.payload);
    void withVisibilityHeartbeat(MESSAGE_PERSISTENCE_QUEUE_URL, item.receiptHandle, VISIBILITY_TIMEOUT_SECONDS, job)
      .then(async () => {
        if (item.receiptHandle) {
          await deleteMessage(MESSAGE_PERSISTENCE_QUEUE_URL, item.receiptHandle).catch((err) => {
            // Persisted but not acked: SQS will redeliver, and persistAssistantTurn's
            // already-persisted check makes that a no-op — safe, just noisy.
            logger.error("Message persistence queue: failed to delete message", {
              err,
              parentMessageId: item.payload.parentMessageId,
            });
          });
        }
      })
      .catch((err) => {
        logger.error(
          item.receiptHandle
            ? "Message persistence queue: job failed — left for SQS redelivery"
            : "Message persistence queue: in-process job failed after retries — reply lost",
          {
            err,
            parentMessageId: item.payload.parentMessageId,
            consultationId: item.payload.consultationId,
          },
        );
      })
      .finally(() => {
        this.active -= 1;
        this.pump();
      });
  }
}

/** persistAssistantTurn with bounded exponential backoff — for the paths that have no SQS
 * receipt behind them. persistAssistantTurn is idempotent (already-persisted check), so a
 * retry after a partial failure cannot double-write. */
async function persistWithRetry(payload: AssistantTurnPayload): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= IN_PROCESS_RETRIES; attempt++) {
    try {
      await ChatSvc.persistAssistantTurn(payload);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < IN_PROCESS_RETRIES) {
        const delay = IN_PROCESS_RETRY_BASE_MS * 2 ** attempt;
        logger.warn("Message persistence: attempt failed, retrying", {
          err,
          attempt: attempt + 1,
          retryInMs: delay,
          parentMessageId: payload.parentMessageId,
        });
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}
