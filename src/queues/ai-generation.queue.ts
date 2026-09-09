import CaseRefreshSvc from "../services/case-refresh.service";
import RedTeamSvc from "../services/red-team.service";
import CaseReconstructionSvc from "../services/case-reconstruction.service";
import { sendMessage, receiveMessages, deleteMessage, withVisibilityHeartbeat } from "../lib/sqs";
import { AI_GENERATION_QUEUE_URL } from "../config";
import logger from "../utils/logger";

export type QueuedAiGenerationKind = "caseRefresh" | "redTeam" | "caseReconstruction";

export interface QueuedAiGenerationJob {
  kind: QueuedAiGenerationKind;
  caseId: string;
  userId: string;
}

// Each kind's controller endpoint already ran CaseAccess.assertCanEdit + AiGenerationLockSvc.begin
// synchronously (see each service's beginQueued) before enqueueing here — runQueued just does the
// actual work and closes out the lock via AiGenerationLockSvc.finishWith.
const RUNNERS: Record<QueuedAiGenerationKind, (caseId: string, userId: string) => Promise<unknown>> = {
  caseRefresh: (caseId, userId) => CaseRefreshSvc.runQueued(caseId, userId),
  redTeam: (caseId, userId) => RedTeamSvc.runQueued(caseId, userId),
  caseReconstruction: (caseId, userId) => CaseReconstructionSvc.runQueued(caseId, userId),
};

// caseRefresh chains three sequential Chat Wonder calls (contradictions scan, case strategy,
// case finding) — generous enough to cover that plus a retry-once on either of the other two
// kinds' single call. Renewed well before expiry (see withVisibilityHeartbeat).
const VISIBILITY_TIMEOUT_SECONDS = 900;
// Each job is one (or a few sequential) Chat Wonder call — I/O-bound, not CPU/memory heavy like
// DocumentExtractionQueue's PDF parsing, so a few can run concurrently without real resource
// pressure. Same reasoning CaseReconstructionAudioQueue used for its poll-only jobs.
const CONCURRENCY = 3;

interface WaitItem {
  job: QueuedAiGenerationJob;
  /** null for the enqueue-failed in-memory fallback — nothing to delete/ack for those. */
  receiptHandle: string | null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shared SQS queue for the Legal Terminal's lawyer-triggered Generate/Refresh actions (Refresh
 * Analysis, Red Team, Case Reconstruction). Each used to run its Chat Wonder call(s) directly
 * inside the HTTP request, tying up the connection for as long as the AI took and risking a
 * timeout on a slow reply. Now the controller does only the fast synchronous part (access check
 * + claiming the AiGenerationJob row) and enqueues here; AiGenerationLockSvc.finish (called from
 * each service's runQueued) is what the Terminal's existing useAiJobStatus poll picks up to
 * auto-invalidate the snapshot — no frontend change needed for that part, since that polling
 * already existed to handle "a job finished somewhere other than this click" (see
 * lib/terminal/mutations.ts).
 *
 * One shared queue instead of three near-identical ones: all three jobs are the same shape (one
 * caseId+userId in, lock closed out on completion), so a `kind` field in the message body plus a
 * RUNNERS dispatch table is less to maintain than three copies of this same SQS plumbing.
 */
export default class AiGenerationQueue {
  private static running = false;
  private static active = 0;
  private static memoryWait: WaitItem[] = [];

  static enqueue(job: QueuedAiGenerationJob): void {
    const body = JSON.stringify(job);
    sendMessage(AI_GENERATION_QUEUE_URL, body).catch((err) => {
      logger.error("Failed to enqueue AI generation job", { err, job });
      this.memoryWait.push({ job, receiptHandle: null });
      this.pump();
    });
  }

  static start(): void {
    if (this.running) return;
    this.running = true;
    void this.run();
  }

  private static async run(): Promise<void> {
    logger.info("AI generation queue started", { concurrency: CONCURRENCY });
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

      const messages = await receiveMessages(AI_GENERATION_QUEUE_URL, available, VISIBILITY_TIMEOUT_SECONDS);
      if (messages.length === 0) continue;

      for (const message of messages) {
        const job = this.parse(message.body);
        if (!job) {
          // Malformed message — drop it rather than let it loop forever.
          void deleteMessage(AI_GENERATION_QUEUE_URL, message.receiptHandle).catch(() => {});
          continue;
        }
        this.memoryWait.push({ job, receiptHandle: message.receiptHandle });
      }
      this.pump();
    }
  }

  private static parse(body: string): QueuedAiGenerationJob | null {
    try {
      const parsed = JSON.parse(body) as Partial<QueuedAiGenerationJob>;
      if (
        parsed &&
        typeof parsed.caseId === "string" &&
        typeof parsed.userId === "string" &&
        typeof parsed.kind === "string" &&
        parsed.kind in RUNNERS
      ) {
        return parsed as QueuedAiGenerationJob;
      }
    } catch {
      // fallthrough to the error log below
    }
    logger.error("AI generation queue: malformed message", { body });
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
    void withVisibilityHeartbeat(AI_GENERATION_QUEUE_URL, item.receiptHandle, VISIBILITY_TIMEOUT_SECONDS, () =>
      RUNNERS[item.job.kind](item.job.caseId, item.job.userId),
    )
      // The runner already records FAILED on the AiGenerationJob row (AiGenerationLockSvc
      // .finishWith) — this catch only stops the rejection from going unhandled.
      .catch((err) => {
        logger.error("AI generation queue: job failed", { err, job: item.job });
      })
      .finally(async () => {
        if (item.receiptHandle) {
          await deleteMessage(AI_GENERATION_QUEUE_URL, item.receiptHandle).catch((err) => {
            logger.error("AI generation queue: failed to delete message", { err, job: item.job });
          });
        }
        this.active -= 1;
        this.pump();
      });
  }
}
