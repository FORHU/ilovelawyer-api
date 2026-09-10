import ChatSvc from "../services/chat.service";
import ChatRepo from "../repositories/chat.repository";
import { sendMessage, receiveMessages, deleteMessage, withVisibilityHeartbeat } from "../lib/sqs";
import { MESSAGE_PERSISTENCE_QUEUE_URL } from "../config";
import { RelatedCase } from "../utils/chatWonder";
import { MindMapItem, TimelineItem, AudioOverviewTurn, ReasoningExplanation } from "../utils/response-parser";
import logger from "../utils/logger";

// A handful of Prisma upserts per job (the turn's structured extras) plus a status flip on
// the already-created Message row(s) — light, so several turns can run at once. Per-instance,
// same caveat as the other queues.
const CONCURRENCY = 5;
// The real job settles well under a second; this is only a safety margin, renewed well
// before expiry (see withVisibilityHeartbeat).
const VISIBILITY_TIMEOUT_SECONDS = 60;

/** What ChatSvc.persistAssistantTurn needs to finish a turn whose assistant Message row(s)
 * sendMessage already created (PENDING). Serialized straight into the SQS message body. */
export interface AssistantTurnPayload {
  consultationId: string;
  /** The turn's assistant row(s) — one, or several sibling topic rows. All flip together to
   * COMPLETE / FAILED. */
  assistantMessageIds: string[];
  /** The row the structured extras attach to (the last topic — greatest createdAt). */
  lastAssistantMessageId: string;
  effectiveCaseId: string | null;
  userId: string;
  relatedCases: RelatedCase[];
  mindMap?: MindMapItem;
  timeline?: TimelineItem[];
  audioOverview?: AudioOverviewTurn[];
  reasoning?: ReasoningExplanation;
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
 * SQS queue that finishes a chat turn after its reply has streamed to the client and its
 * assistant Message row(s) were created PENDING by ChatSvc.sendMessage. The job attaches the
 * slower / failure-prone structured extras (case-timeline promote, mind map, audio overview,
 * reasoning, related cases) and flips the row(s) to COMPLETE — or FAILED. Mirrors the other
 * queues' shape (see citation-extraction.queue.ts); durability is SQS's own redelivery — a
 * message received but never deleted (worker crashed mid-save) reappears after its visibility
 * timeout, so ChatSvc.persistAssistantTurn is written to be idempotent.
 */
export default class MessagePersistenceQueue {
  private static running = false;
  private static active = 0;
  private static memoryWait: WaitItem[] = [];

  static enqueue(payload: AssistantTurnPayload): void {
    if (!payload?.lastAssistantMessageId) return;

    sendMessage(MESSAGE_PERSISTENCE_QUEUE_URL, JSON.stringify(payload)).catch(async (err) => {
      logger.error("Failed to enqueue assistant turn persistence job", {
        err,
        messageId: payload.lastAssistantMessageId,
      });
      // Never leave the turn stuck PENDING. If the worker loop is running, hand it to
      // memoryWait so the CONCURRENCY cap still applies; if the queue never started (no URL
      // configured), attach the extras inline right here.
      if (this.running) {
        this.memoryWait.push({ payload, receiptHandle: null });
        this.pump();
      } else {
        await ChatSvc.persistAssistantTurn(payload).catch((e) => {
          logger.error("Message persistence: inline fallback failed", {
            err: e,
            messageId: payload.lastAssistantMessageId,
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
    // Any assistant row still PENDING from before this process started was orphaned by a
    // crash/redeploy — its content is saved, only the extras were lost. Flip it to COMPLETE
    // so the frontend's status poll terminates. Age-gated inside the repo so a sibling
    // instance's genuinely in-flight turn is left alone.
    ChatRepo.completeStalePendingMessages()
      .then((r) => {
        if (r && r.count > 0) logger.info("Message persistence queue: completed stale PENDING turns", { count: r.count });
      })
      .catch((err) => logger.error("Message persistence queue: stale-PENDING sweep failed", { err }));

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
        typeof parsed.lastAssistantMessageId === "string" &&
        Array.isArray(parsed.assistantMessageIds) &&
        typeof parsed.userId === "string" &&
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
    void withVisibilityHeartbeat(MESSAGE_PERSISTENCE_QUEUE_URL, item.receiptHandle, VISIBILITY_TIMEOUT_SECONDS, () =>
      ChatSvc.persistAssistantTurn(item.payload),
    )
      .catch((err) => {
        logger.error("Message persistence queue: job failed", {
          err,
          messageId: item.payload.lastAssistantMessageId,
        });
      })
      .finally(async () => {
        if (item.receiptHandle) {
          await deleteMessage(MESSAGE_PERSISTENCE_QUEUE_URL, item.receiptHandle).catch((err) => {
            logger.error("Message persistence queue: failed to delete message", {
              err,
              messageId: item.payload.lastAssistantMessageId,
            });
          });
        }
        this.active -= 1;
        this.pump();
      });
  }
}
