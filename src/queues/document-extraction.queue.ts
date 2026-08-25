import DocumentExtractionSvc from "../services/document-extraction.service";
import DocumentRepo from "../repositories/document.repository";
import { createRedisWorkerClient, isRedisReady, redisClient, RedisWorkerClient } from "../lib/redis";
import logger from "../utils/logger";

const WAIT_KEY = "document-extraction:wait";
/** One doc at a time: parallel PDFs OOM a small EC2 and blow the OpenAI 5M TPM cap. */
const CONCURRENCY = 1;
const BRPOP_SECONDS = 2;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Redis list queue for case-document extraction. Confirm endpoints only LPUSH ids;
 * a small worker pool BRPOPs and runs `DocumentExtractionSvc.process` one at a time
 * per slot. If Redis is down, jobs fall back to an in-memory list with the same cap.
 */
export default class DocumentExtractionQueue {
  private static running = false;
  private static active = 0;
  private static memoryWait: string[] = [];
  private static blocker: RedisWorkerClient | null = null;

  static enqueue(documentId: string): void {
    this.enqueueMany([documentId]);
  }

  static enqueueMany(documentIds: string[]): void {
    const ids = documentIds.filter(Boolean);
    if (ids.length === 0) return;

    if (this.blocker?.isReady && isRedisReady()) {
      void redisClient.lPush(WAIT_KEY, ids).catch((err) => {
        logger.error("Failed to enqueue document extraction jobs", { err, count: ids.length });
        this.memoryWait.push(...ids);
        this.pump();
      });
      return;
    }

    this.memoryWait.push(...ids);
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
      logger.error("Document extraction queue: Redis worker connection failed; using in-memory fallback", { err });
      this.blocker = null;
    }

    const pending = await DocumentRepo.listPendingForExtraction().catch((err) => {
      logger.error("Document extraction queue: failed to load PENDING documents", { err });
      return [] as { id: string }[];
    });
    if (pending.length > 0) {
      logger.info("Document extraction queue: re-queuing documents for extraction", { count: pending.length });
      this.enqueueMany(pending.map((doc) => doc.id));
    }

    logger.info("Document extraction queue started", { concurrency: CONCURRENCY });
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
        logger.error("Document extraction queue: BRPOP failed", { err });
        await sleep(1000);
      }
    }
  }

  private static pump(): void {
    if (!this.running) return;

    while (this.active < CONCURRENCY && this.memoryWait.length > 0) {
      const documentId = this.memoryWait.shift();
      if (!documentId) break;
      this.runOne(documentId);
    }
  }

  private static runOne(documentId: string): void {
    this.active += 1;
    void DocumentExtractionSvc.process(documentId).finally(() => {
      this.active -= 1;
      this.pump();
    });
  }
}
