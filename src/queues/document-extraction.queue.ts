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
// Hard ceiling on a single job, independent of whatever it's actually doing. Nothing this
// pipeline calls (S3, Prisma, Textract's own poll loop, OpenAI embeddings) has a matching outer
// timeout of its own — a single hung call (observed: stuck before extraction's own first log
// line, almost certainly the initial DocumentRepo.findByIdWithFile lookup or the S3 download)
// pins `active` at CONCURRENCY forever, which — since CONCURRENCY is 1 — silently and
// permanently stops the *entire* queue from pulling any further work, with no error logged
// anywhere. Set comfortably above the ~10-minute Textract OCR poll ceiling (TEXTRACT_ASYNC_
// MAX_POLL_ATTEMPTS * TEXTRACT_ASYNC_POLL_INTERVAL_MS) so a legitimately slow scanned PDF is
// never mistaken for a hang.
const JOB_HARD_TIMEOUT_MS = 15 * 60_000;
// How often to re-scan the DB for PENDING/FAILED documents nobody's actively working on.
// Without this, the only time a stuck document (enqueue silently lost, process restarted
// mid-batch, etc. — see JOB_HARD_TIMEOUT_MS's own note on this queue's single points of
// failure) ever gets picked back up is the *next* server boot's one-time reload below —
// observed in practice: a batch upload where all but one document sat PENDING for hours with
// zero retry, discovered only when a lawyer asked why their documents were still "indexing."
const PENDING_SWEEP_INTERVAL_MS = 5 * 60_000;
// Only sweep documents older than this — createdAt is upload time, not "extraction attempt
// started" time (the model has no separate timestamp for that), so a document uploaded
// moments ago that's still legitimately waiting its turn in a large batch must not be mistaken
// for stuck. Comfortably above JOB_HARD_TIMEOUT_MS so a single slow-but-healthy job in front of
// it in the queue can't cause a false re-enqueue either.
const PENDING_SWEEP_MIN_AGE_MS = 20 * 60_000;

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
  // Document ids this process currently has a job running for (CONCURRENCY is 1, so at most
  // one entry today, but tracked as a set for when that changes) — the periodic sweep excludes
  // these plus whatever's already sitting in memoryWait, so it never re-queues a document that
  // isn't actually stuck, just because it hasn't reached READY/FAILED yet.
  private static activeDocumentIds = new Set<string>();

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
    // Nothing can legitimately be in flight yet at boot, so no age filter here — every
    // PENDING/FAILED document found is unambiguously stuck from a prior process's lifetime.
    await this.reloadStuckDocuments();

    logger.info("Document extraction queue started", { concurrency: CONCURRENCY });
    void this.fetchLoop();
    void this.sweepLoop();
    this.pump();
  }

  /** Shared by the boot-time reload (no age filter — see run()) and the periodic sweep (age-
   * filtered — see PENDING_SWEEP_MIN_AGE_MS) so both push into the same memoryWait/pump path
   * rather than duplicating it. */
  private static async reloadStuckDocuments(olderThanMs?: number): Promise<void> {
    const pending = await DocumentRepo.listPendingForExtraction(olderThanMs).catch((err) => {
      logger.error("Document extraction queue: failed to load PENDING documents", { err });
      return [] as { id: string }[];
    });
    if (pending.length === 0) return;

    const alreadyQueued = new Set(this.memoryWait.map((item) => item.documentId));
    const toQueue = pending.filter((doc) => !this.activeDocumentIds.has(doc.id) && !alreadyQueued.has(doc.id));
    if (toQueue.length === 0) return;

    logger.info("Document extraction queue: re-queuing documents for extraction", { count: toQueue.length });
    this.memoryWait.push(...toQueue.map((doc) => ({ documentId: doc.id, receiptHandle: null })));
    this.pump();
  }

  private static async sweepLoop(): Promise<void> {
    while (this.running) {
      await sleep(PENDING_SWEEP_INTERVAL_MS);
      if (!this.running) return;
      await this.reloadStuckDocuments(PENDING_SWEEP_MIN_AGE_MS);
    }
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
    this.activeDocumentIds.add(item.documentId);
    // Guards against releasing the slot twice — once from the hard-timeout race below, and
    // again later if the real job eventually settles on its own after all.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.activeDocumentIds.delete(item.documentId);
      this.pump();
    };

    const job = withVisibilityHeartbeat(DOCUMENT_EXTRACTION_QUEUE_URL, item.receiptHandle, VISIBILITY_TIMEOUT_SECONDS, () =>
      DocumentExtractionSvc.process(item.documentId),
    );

    // Races the real job against a hard ceiling — see JOB_HARD_TIMEOUT_MS. This can't cancel a
    // genuinely stuck native/network call underneath `job` (JS has no way to do that), so if it
    // does eventually settle, the `.finally()` below still runs and cleans up normally (deleting
    // the message, or — since `released` is already true — being a no-op on `release()`). If it
    // never settles, the SQS message was never deleted, so its own visibility timeout expiring
    // naturally hands it to a fresh attempt later — this is purely about not letting one stuck
    // job block every other document in every other case in the meantime.
    const timedOut = new Promise<true>((resolve) => setTimeout(() => resolve(true), JOB_HARD_TIMEOUT_MS));
    // Both branches of .then() resolve to false (not just the fulfilled one) so a rejection
    // from `job` can never make this race itself reject — that path is already fully handled
    // below via job.catch(), this is purely "did the real job settle in time, one way or another".
    void Promise.race([job.then(() => false as const, () => false as const), timedOut]).then((didTimeOut) => {
      if (!didTimeOut) return;
      logger.error("Document extraction queue: job exceeded hard timeout, releasing worker slot", {
        documentId: item.documentId,
        timeoutMs: JOB_HARD_TIMEOUT_MS,
      });
      release();
    });

    job
      .catch((err) => {
        logger.error("Document extraction queue: job failed", { err, documentId: item.documentId });
      })
      .finally(async () => {
        if (item.receiptHandle) {
          await deleteMessage(DOCUMENT_EXTRACTION_QUEUE_URL, item.receiptHandle).catch((err) => {
            logger.error("Document extraction queue: failed to delete message", { err, documentId: item.documentId });
          });
        }
        release();
      });
  }
}
