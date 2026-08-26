import CaseReconstructionAudioSvc from "../services/case-reconstruction-audio.service";
import CaseReconstructionRepo from "../repositories/case-reconstruction.repository";
import { createRedisWorkerClient, isRedisReady, redisClient, RedisWorkerClient } from "../lib/redis";
import logger from "../utils/logger";

const WAIT_KEY = "case-reconstruction-audio:poll";
const POLL_INTERVAL_MS = 5_000;
// Ceiling so a Polly task stuck in a state pollAudioJob never sees as terminal can't hold a
// worker slot forever — ~10 minutes, well past any real synthesis job's expected runtime.
const MAX_POLLS = 120;
// Polling is one lightweight GetSpeechSynthesisTaskCommand call, unlike AudioOverviewQueue's
// heavier render (Polly synthesis + ffmpeg merge + S3 upload) — a few can run concurrently
// with no real resource pressure.
const CONCURRENCY = 3;
const BRPOP_SECONDS = 2;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Redis list queue that polls a Case Reconstruction's Polly synthesis task to completion.
 * Polly has no completion webhook, so unlike AudioOverviewQueue (one-shot render),
 * a job here re-polls itself on an interval until pollAudioJob reports a terminal status
 * (COMPLETED/FAILED) or MAX_POLLS is exhausted. Enqueued right after
 * CaseReconstructionAudioSvc.startAudioJob — see case-post-extraction.ts.
 */
export default class CaseReconstructionAudioQueue {
  private static running = false;
  private static active = 0;
  private static memoryWait: string[] = [];
  private static blocker: RedisWorkerClient | null = null;

  static enqueue(caseId: string): void {
    if (!caseId) return;

    if (this.blocker?.isReady && isRedisReady()) {
      void redisClient.lPush(WAIT_KEY, [caseId]).catch((err) => {
        logger.error("Failed to enqueue Case Reconstruction audio poll job", { err, caseId });
        this.memoryWait.push(caseId);
        this.pump();
      });
      return;
    }

    this.memoryWait.push(caseId);
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
      logger.error("Case Reconstruction audio queue: Redis worker connection failed; using in-memory fallback", { err });
      this.blocker = null;
    }

    const pending = await CaseReconstructionRepo.listInProgressAudio().catch((err) => {
      logger.error("Case Reconstruction audio queue: failed to load IN_PROGRESS rows", { err });
      return [] as { caseId: string }[];
    });
    if (pending.length > 0) {
      logger.info("Case Reconstruction audio queue: re-queuing interrupted polls", { count: pending.length });
      for (const row of pending) this.enqueue(row.caseId);
    }

    logger.info("Case Reconstruction audio queue started", { concurrency: CONCURRENCY });
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
        logger.error("Case Reconstruction audio queue: BRPOP failed", { err });
        await sleep(1000);
      }
    }
  }

  private static pump(): void {
    if (!this.running) return;

    while (this.active < CONCURRENCY && this.memoryWait.length > 0) {
      const caseId = this.memoryWait.shift();
      if (!caseId) break;
      this.runOne(caseId);
    }
  }

  private static runOne(caseId: string): void {
    this.active += 1;
    void this.pollUntilDone(caseId).finally(() => {
      this.active -= 1;
      this.pump();
    });
  }

  /** Polly has no completion webhook — poll until CaseReconstructionAudioSvc.pollAudioJob
   * reports a terminal status, same COMPLETED/FAILED states it already returns for the
   * frontend's own manual poll. */
  private static async pollUntilDone(caseId: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      let result: { status: string };
      try {
        result = await CaseReconstructionAudioSvc.pollAudioJob(caseId);
      } catch (err) {
        logger.error("Case Reconstruction audio queue: poll attempt failed", { err, caseId });
        return;
      }
      if (result.status === "COMPLETED" || result.status === "FAILED") {
        logger.info("Case Reconstruction audio queue: poll finished", { caseId, status: result.status });
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    logger.warn("Case Reconstruction audio queue: gave up polling (max attempts)", { caseId });
  }
}
