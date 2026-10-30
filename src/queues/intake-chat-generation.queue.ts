import IntakeChatSvc from "../services/intake-chat.service";
import IntakeChatRepo from "../repositories/intake-chat.repository";
import { emitToUser } from "../lib/socket";
import { sendMessage, receiveMessages, deleteMessage, withVisibilityHeartbeat } from "../lib/sqs";
import { INTAKE_CHAT_GENERATION_QUEUE_URL } from "../config";
import { TenantCode } from "../types/tenant-code";
import logger from "../utils/logger";

/**
 * The intake chat pipeline's own SQS queue and worker — a fully independent implementation, not
 * an instance of chat-generation.queue.ts's ChatGenerationQueueWorker. Per the 2026-10-28
 * intake-pipeline separation: nothing about this queue — its job shape, its processor, its
 * stale-sweep — is shared with the lawyer/client chat queues, even though the mechanics are
 * necessarily similar. A bugfix made here should be checked against chat-generation.queue.ts too,
 * and vice versa — accepted deliberately, not an oversight.
 *
 * Job shape differs from ChatGenerationJob in one structural way: this is keyed by `caseId`
 * directly, with no `consultationId`/`effectiveCaseId` indirection — an intake thread *is* its
 * case, there's no separate session/thread concept.
 *
 * Acking: always acks in `runOne`'s `finally`, same reasoning as the lawyer/client queues —
 * IntakeMessage.replyStatus is this job's own durable status record, so a "controlled" failure
 * doesn't need SQS to blindly retry. A genuine worker crash (never reaching the ack) is the one
 * case SQS's redelivery is relied on for; IntakeChatSvc's persistence is written to be safe
 * against that redelivery.
 */
export interface IntakeChatGenerationJob {
  /** The user IntakeMessage's id — the durable job record, same idiom as ChatGenerationJob.jobId. */
  jobId: string;
  tenantCode: TenantCode;
  userId: string;
  caseId: string;
  sessionId: string;
  /** Empty for a voice-originated turn until the worker transcribes audioS3Key — see
   * IntakeChatSvc.runIntakeGenerationJob's transcription step, which fills this in before doing
   * anything else. */
  userInput: string;
  documentIds?: string[];
  /** Set only for a voice-originated turn: the client's recorded audio, already uploaded to S3.
   * The worker transcribes this first and uses the result as userInput for the rest of the job. */
  audioS3Key?: string;
  enqueuedAt?: number;
}

const VISIBILITY_TIMEOUT_SECONDS = 300;
const CONCURRENCY = 10;
const STALE_PENDING_CEILING_MS = 15 * 60_000;
const SWEEP_INTERVAL_MS = 2 * 60_000;

interface WaitItem {
  job: IntakeChatGenerationJob;
  receiptHandle: string | null;
  sqsMessageId?: string;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class IntakeChatGenerationQueueWorker {
  private running = false;
  private active = 0;
  private memoryWait: WaitItem[] = [];

  enqueue(job: IntakeChatGenerationJob): void {
    if (!job?.jobId) return;
    job.enqueuedAt = job.enqueuedAt ?? Date.now();

    sendMessage(INTAKE_CHAT_GENERATION_QUEUE_URL, JSON.stringify(job)).catch((err) => {
      logger.error("Failed to enqueue intake chat generation job — falling back to in-process", {
        err,
        jobId: job.jobId,
        caseId: job.caseId,
      });
      // Never drop a turn the user is actively waiting on.
      if (this.running) {
        logger.warn("Intake chat generation: SQS send failed, queued in-process instead", { jobId: job.jobId });
        this.memoryWait.push({ job, receiptHandle: null });
        this.pump();
      } else {
        logger.warn("Intake chat generation: queue not running, processing this job fully inline", { jobId: job.jobId });
        void IntakeChatSvc.processIntakeGenerationJob(job).catch((e: unknown) => {
          logger.error("Intake chat generation: inline fallback failed", { err: e, jobId: job.jobId, caseId: job.caseId });
        });
      }
    });
  }

  start(): void {
    if (this.running) return;
    if (!INTAKE_CHAT_GENERATION_QUEUE_URL) {
      logger.error("Intake chat generation queue: INTAKE_CHAT_GENERATION_QUEUE_URL is not set, refusing to start");
      return;
    }
    this.running = true;
    void this.fetchLoop();
    this.pump();
  }

  private async fetchLoop(): Promise<void> {
    while (this.running) {
      const available = CONCURRENCY - this.active - this.memoryWait.length;
      if (available <= 0) {
        await sleep(200);
        continue;
      }

      const messages = await receiveMessages(INTAKE_CHAT_GENERATION_QUEUE_URL, available, VISIBILITY_TIMEOUT_SECONDS);
      if (messages.length === 0) continue;

      for (const message of messages) {
        const job = this.parse(message.body);
        if (!job) {
          logger.error("Intake chat generation: dropping malformed SQS message", { sqsMessageId: message.messageId });
          void deleteMessage(INTAKE_CHAT_GENERATION_QUEUE_URL, message.receiptHandle).catch(() => {});
          continue;
        }
        this.memoryWait.push({ job, receiptHandle: message.receiptHandle, sqsMessageId: message.messageId });
      }
      this.pump();
    }
  }

  private parse(body: string): IntakeChatGenerationJob | null {
    let parsed: Partial<IntakeChatGenerationJob> | undefined;
    try {
      parsed = JSON.parse(body) as Partial<IntakeChatGenerationJob>;
    } catch (err) {
      logger.error("Intake chat generation queue: message body is not valid JSON", { err, body });
      return null;
    }
    if (parsed && typeof parsed.jobId === "string" && typeof parsed.caseId === "string" && typeof parsed.userId === "string" && typeof parsed.sessionId === "string" && typeof parsed.userInput === "string") {
      return parsed as IntakeChatGenerationJob;
    }
    logger.error("Intake chat generation queue: message JSON doesn't match IntakeChatGenerationJob's shape", {
      keysPresent: parsed ? Object.keys(parsed) : [],
    });
    return null;
  }

  private pump(): void {
    if (!this.running) return;
    while (this.active < CONCURRENCY && this.memoryWait.length > 0) {
      const item = this.memoryWait.shift();
      if (!item) break;
      this.runOne(item);
    }
  }

  private runOne(item: WaitItem): void {
    this.active += 1;
    const startedAt = Date.now();
    void withVisibilityHeartbeat(INTAKE_CHAT_GENERATION_QUEUE_URL, item.receiptHandle, VISIBILITY_TIMEOUT_SECONDS, () =>
      IntakeChatSvc.processIntakeGenerationJob(item.job),
    )
      .catch((err) => {
        logger.error("Intake chat generation: job failed", {
          err,
          jobId: item.job.jobId,
          caseId: item.job.caseId,
          sqsMessageId: item.sqsMessageId,
          durationMs: Date.now() - startedAt,
        });
      })
      .finally(async () => {
        if (item.receiptHandle) {
          await deleteMessage(INTAKE_CHAT_GENERATION_QUEUE_URL, item.receiptHandle).catch((err) => {
            logger.error("Intake chat generation queue: failed to delete message", { err, jobId: item.job.jobId, sqsMessageId: item.sqsMessageId });
          });
        }
        this.active -= 1;
        this.pump();
      });
  }
}

const IntakeChatGenerationQueue = new IntakeChatGenerationQueueWorker();
export default IntakeChatGenerationQueue;

/** Marks intake turns that have been PENDING past STALE_PENDING_CEILING_MS as FAILED and tells
 * the asker (chat:error) — the intake pipeline's own sweep, never the lawyer/client queues'
 * unified one (that sweep reads Message, this one reads IntakeMessage; keeping them apart means
 * neither can accidentally touch the other's rows). */
let sweeping = false;

export function startIntakeStalePendingSweep(): void {
  if (sweeping) return;
  sweeping = true;
  void (async () => {
    while (sweeping) {
      await sleep(SWEEP_INTERVAL_MS);
      try {
        await sweepStalePendingIntakeChats();
      } catch (err) {
        logger.error("Intake chat generation: stale-pending sweep failed", { err });
      }
    }
  })();
}

export async function sweepStalePendingIntakeChats(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_PENDING_CEILING_MS);
  const stale = await IntakeChatRepo.findStalePending(cutoff);
  if (stale.length === 0) return;

  logger.warn("Intake chat generation: sweeping stale PENDING turns to FAILED", {
    count: stale.length,
    messageIds: stale.map((m) => m.id),
  });

  for (const message of stale) {
    try {
      await IntakeChatRepo.setReplyStatus(message.id, "FAILED", { clearPendingContent: true });
      if (message.userId) {
        emitToUser(message.userId, "chat:error", {
          caseId: message.caseId,
          messageId: message.id,
          message: "Generation timed out",
        });
      }
    } catch (err) {
      logger.error("Intake chat generation: failed to sweep stale PENDING turn", { err, messageId: message.id });
    }
  }
}
