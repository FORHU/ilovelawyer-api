import CaseRefreshSvc from "../services/case-refresh.service";
import RedTeamSvc from "../services/red-team.service";
import WitnessScoringSvc from "../services/witness-scoring.service";
import WitnessExtractSvc from "../services/witness-extract.service";
import EvidenceIntelligenceSvc from "../services/evidence-intelligence.service";
import CaseReconstructionSvc from "../services/case-reconstruction.service";
import CaseTheorySvc from "../services/case-theory.service";
import TheoryDiffSvc from "../services/theory-diff.service";
import CaseTimelineSvc from "../services/case-timeline.service";
import { sendMessage, receiveMessages, deleteMessage, withVisibilityHeartbeat } from "../lib/sqs";
import { AI_GENERATION_QUEUE_URL } from "../config";
import logger from "../utils/logger";

export type QueuedAiGenerationKind =
  | "caseRefresh"
  | "redTeam"
  | "caseReconstruction"
  | "caseTheoryPropose"
  | "theoryDiff"
  | "caseReconstructionScenes"
  | "caseReconstructionTableRead"
  | "casePostExtraction"
  | "timelineGenerate"
  | "witnessScoring"
  | "witnessExtract"
  | "contradictions";

export interface QueuedAiGenerationJob {
  kind: QueuedAiGenerationKind;
  caseId: string;
  userId: string;
  // theoryDiff only — which pair to diff. Every other kind ignores these.
  theoryAId?: string;
  theoryBId?: string;
}

// Each of caseRefresh/redTeam/caseReconstruction/caseTheoryPropose/theoryDiff/
// caseReconstructionScenes/caseReconstructionTableRead's controller endpoint already ran
// CaseAccess.assertCanEdit + AiGenerationLockSvc.begin synchronously (see each service's
// beginQueued) before enqueueing here — runQueued just does the actual work and closes out the
// lock via AiGenerationLockSvc.finishWith.
//
// casePostExtraction is different: it's the auto-refresh trigger itself
// (queues/case-post-extraction.ts), not a job whose lock was already claimed by a controller —
// its own runner decides whether a refresh is actually warranted (pending docs / unchanged READY
// set / already in progress) and claims AiGenerationLockSvc.begin("caseRefresh") itself once it
// is. Routed through a dynamic import rather than a top-level one: case-post-extraction.ts needs
// to call AiGenerationQueue.enqueue (to durably schedule/reschedule itself via SQS — see
// scheduleCasePostExtraction), which would make this a circular top-level import if this file
// also statically imported case-post-extraction.ts. The dynamic import only resolves once a
// message is actually being processed, well after both modules have finished loading, so the
// cycle never matters at module-init time.
const RUNNERS: Record<QueuedAiGenerationKind, (job: QueuedAiGenerationJob) => Promise<unknown>> = {
  caseRefresh: (job) => CaseRefreshSvc.runQueued(job.caseId, job.userId),
  redTeam: (job) => RedTeamSvc.runQueued(job.caseId, job.userId),
  caseReconstruction: (job) => CaseReconstructionSvc.runQueued(job.caseId, job.userId),
  caseTheoryPropose: (job) => CaseTheorySvc.runQueuedPropose(job.caseId, job.userId),
  theoryDiff: (job) => TheoryDiffSvc.runQueuedDiff(job.caseId, job.userId, job.theoryAId!, job.theoryBId!),
  caseReconstructionScenes: (job) => CaseReconstructionSvc.runQueuedScenes(job.caseId, job.userId),
  caseReconstructionTableRead: (job) => CaseReconstructionSvc.runQueuedTableRead(job.caseId, job.userId),
  casePostExtraction: async (job) => {
    const { runCasePostExtraction } = await import("./case-post-extraction");
    return runCasePostExtraction(job.caseId, job.userId);
  },
  timelineGenerate: (job) => CaseTimelineSvc.runQueuedGenerate(job.caseId, job.userId),
  witnessScoring: (job) => WitnessScoringSvc.runQueued(job.caseId, job.userId),
  // No controller in front of this one — it's enqueued by runCasePostExtraction and claims its
  // own lock (see WitnessExtractSvc.runQueued), same as casePostExtraction.
  witnessExtract: (job) => WitnessExtractSvc.runQueued(job.caseId, job.userId),
  contradictions: (job) => EvidenceIntelligenceSvc.runQueuedScan(job.caseId),
};

// caseRefresh chains three sequential Chat Wonder calls (contradictions scan, case strategy,
// case finding) — generous enough to cover that plus a retry-once on either of the other two
// kinds' single call. casePostExtraction can chain that same caseRefresh work plus a fourth,
// heavier first-ingest reconstruction + Polly call (see case-post-extraction.ts) — a slower
// worst case than any other kind here, but not a hard ceiling risk: withVisibilityHeartbeat
// keeps renewing on an interval for as long as the job is still running, regardless of total
// elapsed time, so this constant only has to outlast the gap before the first renewal.
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

  /** `delaySeconds` is only meaningful on the real SQS path — the in-memory fallback below (used
   * when sendMessage itself fails, e.g. the queue is misconfigured/unreachable) runs the job
   * immediately regardless, same as it always has for the other kinds. That's an accepted
   * degraded-mode trade-off: an infra outage turns a delayed/debounced trigger into an immediate
   * one rather than dropping it, and casePostExtraction's own pending/fingerprint checks
   * (case-post-extraction.ts) still guard against that being wasteful. */
  static enqueue(job: QueuedAiGenerationJob, delaySeconds?: number): void {
    const body = JSON.stringify(job);
    sendMessage(AI_GENERATION_QUEUE_URL, body, delaySeconds).catch((err) => {
      logger.error("Failed to enqueue AI generation job", { err, job });
      this.memoryWait.push({ job, receiptHandle: null });
      this.pump();
    });
  }

  static start(): void {
    if (this.running) return;
    // receiveMessages() swallows its own errors (by design — see lib/sqs.ts) and returns [],
    // so an empty/missing queue URL (e.g. a deploy that shipped before the AI_GENERATION_QUEUE_URL
    // secret existed) would otherwise make fetchLoop spin on ReceiveMessageCommand with no
    // backoff at all, burning CPU/sockets on the same process as every other queue's worker
    // instead of just quietly doing nothing.
    if (!AI_GENERATION_QUEUE_URL) {
      logger.error("AI generation queue: AI_GENERATION_QUEUE_URL is not set, refusing to start");
      return;
    }
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
    const startedAt = Date.now();
    logger.info("AI generation queue: job started", { kind: item.job.kind, caseId: item.job.caseId });
    void withVisibilityHeartbeat(AI_GENERATION_QUEUE_URL, item.receiptHandle, VISIBILITY_TIMEOUT_SECONDS, () =>
      RUNNERS[item.job.kind](item.job),
    )
      .then(() => {
        logger.info("AI generation queue: job finished", {
          kind: item.job.kind,
          caseId: item.job.caseId,
          durationMs: Date.now() - startedAt,
        });
      })
      // The runner already records FAILED on the AiGenerationJob row (AiGenerationLockSvc
      // .finishWith) — this catch only stops the rejection from going unhandled.
      .catch((err) => {
        logger.error("AI generation queue: job failed", { err, job: item.job, durationMs: Date.now() - startedAt });
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
