import CitationExtractionSvc from "../services/citation-extraction.service";
import AiGenerationLockSvc from "../services/ai-generation-lock.service";
import { createRedisWorkerClient, isRedisReady, redisClient, RedisWorkerClient } from "../lib/redis";
import logger from "../utils/logger";

const WAIT_KEY = "citation-extraction:wait";
// Bounds simultaneous PDF-fetch+LLM jobs across every app instance — this codebase has no
// general LLM cost/rate control, so this cap is also the de facto spend limiter for a
// recursive, user-triggered feature. See docs/plan (Citation Map).
const CONCURRENCY = 3;
const BRPOP_SECONDS = 2;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Redis list queue for citation extraction (one-shot job: fetch decision PDF, run the LLM
 * extraction, persist CitationEdge rows), mirroring DocumentExtractionQueue's shape. Unlike
 * that queue, there's no restart-recovery re-enqueue here — a job interrupted mid-flight simply
 * never stamps `Law.citationsExtractedAt`, so the row still reads as "not yet extracted" and a
 * fresh expand click naturally retries it; nothing needs to remember it was in progress.
 */
export default class CitationExtractionQueue {
  private static running = false;
  private static active = 0;
  private static memoryWait: string[] = [];
  private static blocker: RedisWorkerClient | null = null;

  static enqueue(lawId: string): void {
    if (!lawId) return;

    if (this.blocker?.isReady && isRedisReady()) {
      void redisClient.lPush(WAIT_KEY, [lawId]).catch((err) => {
        logger.error("Failed to enqueue citation extraction job", { err, lawId });
        this.memoryWait.push(lawId);
        this.pump();
      });
      return;
    }

    this.memoryWait.push(lawId);
    this.pump();
  }

  static start(): void {
    if (this.running) return;
    this.running = true;
    void this.run();
  }

  private static async run(): Promise<void> {
    try {
      this.blocker = createRedisWorkerClient();
      await this.blocker.connect();
    } catch (err) {
      logger.error("Citation extraction queue: Redis worker connection failed; using in-memory fallback", { err });
      this.blocker = null;
    }

    logger.info("Citation extraction queue started", { concurrency: CONCURRENCY });
    void this.fetchLoop();
    this.pump();
  }

  private static async fetchLoop(): Promise<void> {
    while (this.running) {
      if (!this.blocker?.isReady || this.active + this.memoryWait.length >= CONCURRENCY) {
        await sleep(200);
        continue;
      }

      try {
        const popped = await this.blocker.brPop(WAIT_KEY, BRPOP_SECONDS);
        if (popped?.element) {
          this.memoryWait.push(popped.element);
          this.pump();
        }
      } catch (err) {
        logger.error("Citation extraction queue: BRPOP failed", { err });
        await sleep(1000);
      }
    }
  }

  private static pump(): void {
    if (!this.running) return;

    while (this.active < CONCURRENCY && this.memoryWait.length > 0) {
      const lawId = this.memoryWait.shift();
      if (!lawId) break;
      this.runOne(lawId);
    }
  }

  private static runOne(lawId: string): void {
    this.active += 1;
    // The controller already called AiGenerationLockSvc.begin before enqueueing (that's what
    // stops a duplicate enqueue for the same lawId) — this job just needs to close it out.
    CitationExtractionSvc.expand(lawId)
      .then(() => AiGenerationLockSvc.finish(lawId, "citationExpand", "DONE"))
      .catch((err) => {
        logger.error("Citation extraction queue: job failed", { err, lawId });
        return AiGenerationLockSvc.finish(
          lawId,
          "citationExpand",
          "FAILED",
          err instanceof Error ? err.message : String(err),
        ).catch(() => {});
      })
      .finally(() => {
        this.active -= 1;
        this.pump();
      });
  }
}
