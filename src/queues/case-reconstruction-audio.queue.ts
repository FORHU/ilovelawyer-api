import CaseReconstructionAudioSvc from "../services/case-reconstruction-audio.service";
import CaseReconstructionRepo from "../repositories/case-reconstruction.repository";
import { sendMessage, receiveMessages, deleteMessage, withVisibilityHeartbeat } from "../lib/sqs";
import { CASE_RECONSTRUCTION_AUDIO_QUEUE_URL } from "../config";
import logger from "../utils/logger";

const POLL_INTERVAL_MS = 5_000;
// Ceiling so a Polly task stuck in a state pollAudioJob never sees as terminal can't hold a
// worker slot forever — ~10 minutes, well past any real synthesis job's expected runtime.
const MAX_POLLS = 120;
// Covers the full MAX_POLLS * POLL_INTERVAL_MS (~10 min) loop plus buffer — renewed well
// before expiry (see withVisibilityHeartbeat) so this is a safety margin, not a real limit.
const VISIBILITY_TIMEOUT_SECONDS = 660;
// Polling is one lightweight GetSpeechSynthesisTaskCommand call, unlike AudioOverviewQueue's
// heavier render (Polly synthesis + ffmpeg merge + S3 upload) — a few can run concurrently
// with no real resource pressure.
const CONCURRENCY = 3;

interface WaitItem {
  caseId: string;
  /** null for the enqueue-failed in-memory fallback or a re-queued-on-boot row — nothing to
   * delete/ack for those. */
  receiptHandle: string | null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SQS queue that polls a Case Reconstruction's Polly synthesis task to completion. Polly has
 * no completion webhook, so unlike AudioOverviewQueue (one-shot render), a job here re-polls
 * itself on an interval until pollAudioJob reports a terminal status (COMPLETED/FAILED) or
 * MAX_POLLS is exhausted. Enqueued right after CaseReconstructionAudioSvc.startAudioJob — see
 * case-post-extraction.ts.
 */
export default class CaseReconstructionAudioQueue {
  private static running = false;
  private static active = 0;
  private static memoryWait: WaitItem[] = [];

  static enqueue(caseId: string): void {
    if (!caseId) return;

    sendMessage(CASE_RECONSTRUCTION_AUDIO_QUEUE_URL, caseId).catch((err) => {
      logger.error("Failed to enqueue Case Reconstruction audio poll job", { err, caseId });
      this.memoryWait.push({ caseId, receiptHandle: null });
      this.pump();
    });
  }

  static start(): void {
    if (this.running) return;
    this.running = true;
    void this.run();
  }

  private static async run(): Promise<void> {
    const pending = await CaseReconstructionRepo.listInProgressAudio().catch((err) => {
      logger.error("Case Reconstruction audio queue: failed to load IN_PROGRESS rows", { err });
      return [] as { caseId: string }[];
    });
    if (pending.length > 0) {
      logger.info("Case Reconstruction audio queue: re-queuing interrupted polls", { count: pending.length });
      this.memoryWait.push(...pending.map((row) => ({ caseId: row.caseId, receiptHandle: null })));
      this.pump();
    }

    logger.info("Case Reconstruction audio queue started", { concurrency: CONCURRENCY });
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

      const messages = await receiveMessages(CASE_RECONSTRUCTION_AUDIO_QUEUE_URL, available, VISIBILITY_TIMEOUT_SECONDS);
      if (messages.length > 0) {
        this.memoryWait.push(...messages.map((m) => ({ caseId: m.body, receiptHandle: m.receiptHandle })));
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
    void withVisibilityHeartbeat(CASE_RECONSTRUCTION_AUDIO_QUEUE_URL, item.receiptHandle, VISIBILITY_TIMEOUT_SECONDS, () =>
      this.pollUntilDone(item.caseId),
    ).finally(async () => {
      if (item.receiptHandle) {
        await deleteMessage(CASE_RECONSTRUCTION_AUDIO_QUEUE_URL, item.receiptHandle).catch((err) => {
          logger.error("Case Reconstruction audio queue: failed to delete message", { err, caseId: item.caseId });
        });
      }
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
