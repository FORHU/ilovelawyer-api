import CitationExtractionSvc from "../services/citation-extraction.service";
import AiGenerationLockSvc from "../services/ai-generation-lock.service";
import { sendMessage, receiveMessages, deleteMessage, withVisibilityHeartbeat } from "../lib/sqs";
import { CITATION_EXTRACTION_QUEUE_URL } from "../config";
import logger from "../utils/logger";

// Bounds simultaneous PDF-fetch+LLM jobs across every app instance — this codebase has no
// general LLM cost/rate control, so this cap is also the de facto spend limiter for a
// recursive, user-triggered feature. See docs/plan (Citation Map).
const CONCURRENCY = 3;
// A single PDF-fetch + one LLM call — comfortably under this, renewed well before expiry.
const VISIBILITY_TIMEOUT_SECONDS = 180;

interface WaitItem {
  lawId: string;
  /** null for the enqueue-failed in-memory fallback — nothing to delete/ack for those. */
  receiptHandle: string | null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SQS queue for citation extraction (one-shot job: fetch decision PDF, run the LLM
 * extraction, persist CitationEdge rows), mirroring DocumentExtractionQueue's shape. Unlike
 * that queue, there's no restart-recovery re-enqueue here — a job interrupted mid-flight simply
 * never stamps `Law.citationsExtractedAt`, so the row still reads as "not yet extracted" and a
 * fresh expand click naturally retries it; nothing needs to remember it was in progress.
 */
export default class CitationExtractionQueue {
  private static running = false;
  private static active = 0;
  private static memoryWait: WaitItem[] = [];

  static enqueue(lawId: string): void {
    if (!lawId) return;

    sendMessage(CITATION_EXTRACTION_QUEUE_URL, lawId).catch((err) => {
      logger.error("Failed to enqueue citation extraction job", { err, lawId });
      this.memoryWait.push({ lawId, receiptHandle: null });
      this.pump();
    });
  }

  static start(): void {
    if (this.running) return;
    this.running = true;
    void this.run();
  }

  private static async run(): Promise<void> {
    logger.info("Citation extraction queue started", { concurrency: CONCURRENCY });
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

      const messages = await receiveMessages(CITATION_EXTRACTION_QUEUE_URL, available, VISIBILITY_TIMEOUT_SECONDS);
      if (messages.length > 0) {
        this.memoryWait.push(...messages.map((m) => ({ lawId: m.body, receiptHandle: m.receiptHandle })));
        this.pump();
      }
    }
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
    // The controller already called AiGenerationLockSvc.begin before enqueueing (that's what
    // stops a duplicate enqueue for the same lawId) — this job just needs to close it out.
    withVisibilityHeartbeat(CITATION_EXTRACTION_QUEUE_URL, item.receiptHandle, VISIBILITY_TIMEOUT_SECONDS, () =>
      CitationExtractionSvc.expand(item.lawId),
    )
      .then(() => AiGenerationLockSvc.finish(item.lawId, "citationExpand", "DONE"))
      .catch((err) => {
        logger.error("Citation extraction queue: job failed", { err, lawId: item.lawId });
        return AiGenerationLockSvc.finish(
          item.lawId,
          "citationExpand",
          "FAILED",
          err instanceof Error ? err.message : String(err),
        ).catch(() => {});
      })
      .finally(async () => {
        if (item.receiptHandle) {
          await deleteMessage(CITATION_EXTRACTION_QUEUE_URL, item.receiptHandle).catch((err) => {
            logger.error("Citation extraction queue: failed to delete message", { err, lawId: item.lawId });
          });
        }
        this.active -= 1;
        this.pump();
      });
  }
}
