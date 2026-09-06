import DocumentExtractionSvc from "../services/document-extraction.service";
import DocumentRepo from "../repositories/document.repository";
import { sendMessageBatch, receiveMessages, deleteMessage, withVisibilityHeartbeat } from "../lib/sqs";
import { DOCUMENT_EXTRACTION_QUEUE_URL } from "../config";
import logger from "../utils/logger";

/** One doc at a time: parallel PDFs OOM a small EC2 and blow the OpenAI 5M TPM cap. */
const CONCURRENCY = 1;
// Generous ceiling for a large multi-page PDF's extraction + embedding — renewed well before
// expiry (see withVisibilityHeartbeat) so this is a safety margin, not a real limit.
const VISIBILITY_TIMEOUT_SECONDS = 600;

interface WaitItem {
  documentId: string;
  /** null for an item that was never actually an SQS message (the enqueue-failed fallback, or
   * a PENDING doc re-queued from the DB on boot) — nothing to delete/ack for those. */
  receiptHandle: string | null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SQS queue for case-document extraction. Confirm endpoints send a message per document id;
 * a small worker pool long-polls and runs `DocumentExtractionSvc.process` one at a time per
 * slot. If a send fails (network blip, misconfigured queue), the job falls back to an
 * in-memory list with the same concurrency cap rather than being silently dropped.
 */
export default class DocumentExtractionQueue {
  private static running = false;
  private static active = 0;
  private static memoryWait: WaitItem[] = [];

  static enqueue(documentId: string): void {
    this.enqueueMany([documentId]);
  }

  static enqueueMany(documentIds: string[]): void {
    const ids = documentIds.filter(Boolean);
    if (ids.length === 0) return;

    sendMessageBatch(DOCUMENT_EXTRACTION_QUEUE_URL, ids).catch((err) => {
      logger.error("Failed to enqueue document extraction jobs", { err, count: ids.length });
      this.memoryWait.push(...ids.map((documentId) => ({ documentId, receiptHandle: null })));
      this.pump();
    });
  }

  static start(): void {
    if (this.running) return;
    this.running = true;
    void this.run();
  }

  private static async run(): Promise<void> {
    const pending = await DocumentRepo.listPendingForExtraction().catch((err) => {
      logger.error("Document extraction queue: failed to load PENDING documents", { err });
      return [] as { id: string }[];
    });
    if (pending.length > 0) {
      logger.info("Document extraction queue: re-queuing documents for extraction", { count: pending.length });
      this.memoryWait.push(...pending.map((doc) => ({ documentId: doc.id, receiptHandle: null })));
      this.pump();
    }

    logger.info("Document extraction queue started", { concurrency: CONCURRENCY });
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

      const messages = await receiveMessages(DOCUMENT_EXTRACTION_QUEUE_URL, available, VISIBILITY_TIMEOUT_SECONDS);
      if (messages.length > 0) {
        this.memoryWait.push(...messages.map((m) => ({ documentId: m.body, receiptHandle: m.receiptHandle })));
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
    void withVisibilityHeartbeat(DOCUMENT_EXTRACTION_QUEUE_URL, item.receiptHandle, VISIBILITY_TIMEOUT_SECONDS, () =>
      DocumentExtractionSvc.process(item.documentId),
    )
      .catch((err) => {
        logger.error("Document extraction queue: job failed", { err, documentId: item.documentId });
      })
      .finally(async () => {
        if (item.receiptHandle) {
          await deleteMessage(DOCUMENT_EXTRACTION_QUEUE_URL, item.receiptHandle).catch((err) => {
            logger.error("Document extraction queue: failed to delete message", { err, documentId: item.documentId });
          });
        }
        this.active -= 1;
        this.pump();
      });
  }
}
