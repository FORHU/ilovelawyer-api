import AudioOverviewAudioSvc from "../services/audio-overview-audio.service";
import ChatRepo from "../repositories/chat.repository";
import { createRedisWorkerClient, isRedisReady, redisClient, RedisWorkerClient } from "../lib/redis";
import logger from "../utils/logger";

const WAIT_KEY = "audio-overview:wait";
// One render job at a time across the whole server — each one already runs up to
// TURN_SYNTHESIS_CONCURRENCY Polly calls internally plus an ffmpeg process; running several
// full Audio Overview jobs at once would multiply both the Polly rate-limit pressure and the
// ffmpeg/memory footprint for no real benefit (there's no user-facing reason two renders need
// to race each other). Same reasoning DocumentExtractionQueue used for CONCURRENCY = 1.
const CONCURRENCY = 1;
const BRPOP_SECONDS = 2;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Redis list queue for Audio Overview rendering (script → Polly synthesis → ffmpeg merge →
 * S3). The "Generate Audio" action only ever LPUSHes a messageId; a single worker slot BRPOPs
 * and runs AudioOverviewAudioSvc.process. Exact same shape as DocumentExtractionQueue,
 * including the in-memory fallback when Redis is down — see that file's own comment for why
 * this shape (not a fire-and-forget in-process promise) is the right one for real background
 * work that must survive the request that kicked it off.
 */
export default class AudioOverviewQueue {
  private static running = false;
  private static active = 0;
  private static memoryWait: string[] = [];
  private static blocker: RedisWorkerClient | null = null;

  static enqueue(messageId: string): void {
    if (!messageId) return;

    if (this.blocker?.isReady && isRedisReady()) {
      void redisClient.lPush(WAIT_KEY, [messageId]).catch((err) => {
        logger.error("Failed to enqueue Audio Overview render job", { err, messageId });
        this.memoryWait.push(messageId);
        this.pump();
      });
      return;
    }

    this.memoryWait.push(messageId);
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
      logger.error("Audio Overview queue: Redis worker connection failed; using in-memory fallback", { err });
      this.blocker = null;
    }

    const pending = await ChatRepo.listInProgressAudioOverviews().catch((err) => {
      logger.error("Audio Overview queue: failed to load IN_PROGRESS rows", { err });
      return [] as { messageId: string }[];
    });
    if (pending.length > 0) {
      logger.info("Audio Overview queue: re-queuing interrupted renders", { count: pending.length });
      for (const row of pending) this.enqueue(row.messageId);
    }

    logger.info("Audio Overview queue started", { concurrency: CONCURRENCY });
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
        logger.error("Audio Overview queue: BRPOP failed", { err });
        await sleep(1000);
      }
    }
  }

  private static pump(): void {
    if (!this.running) return;

    while (this.active < CONCURRENCY && this.memoryWait.length > 0) {
      const messageId = this.memoryWait.shift();
      if (!messageId) break;
      this.runOne(messageId);
    }
  }

  private static runOne(messageId: string): void {
    this.active += 1;
    void AudioOverviewAudioSvc.process(messageId).finally(() => {
      this.active -= 1;
      this.pump();
    });
  }
}
