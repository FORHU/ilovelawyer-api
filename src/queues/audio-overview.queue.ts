import AudioOverviewAudioSvc from "../services/audio-overview-audio.service";
import ChatRepo from "../repositories/chat.repository";
import { sendMessage, receiveMessages, deleteMessage, withVisibilityHeartbeat } from "../lib/sqs";
import { AUDIO_OVERVIEW_QUEUE_URL } from "../config";
import logger from "../utils/logger";

// Generous ceiling for a long multi-turn script's Polly synthesis + ffmpeg merge — renewed
// well before expiry (see withVisibilityHeartbeat) so this is a safety margin, not a real limit.
const VISIBILITY_TIMEOUT_SECONDS = 600;

// One render job at a time across the whole server — each one already runs up to
// TURN_SYNTHESIS_CONCURRENCY Polly calls internally plus an ffmpeg process; running several
// full Audio Overview jobs at once would multiply both the Polly rate-limit pressure and the
// ffmpeg/memory footprint for no real benefit (there's no user-facing reason two renders need
// to race each other). Same reasoning DocumentExtractionQueue used for CONCURRENCY = 1.
const CONCURRENCY = 1;

interface WaitItem {
  messageId: string;
  /** null for the enqueue-failed in-memory fallback or a re-queued-on-boot row — nothing to
   * delete/ack for those. */
  receiptHandle: string | null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SQS queue for Audio Overview rendering (script → Polly synthesis → ffmpeg merge → S3). The
 * "Generate Audio" action sends a messageId; a single worker slot long-polls and runs
 * AudioOverviewAudioSvc.process. Exact same shape as DocumentExtractionQueue, including the
 * in-memory fallback when an enqueue send fails — see that file's own comment for why this
 * shape (not a fire-and-forget in-process promise) is the right one for real background work
 * that must survive the request that kicked it off.
 */
export default class AudioOverviewQueue {
  private static running = false;
  private static active = 0;
  private static memoryWait: WaitItem[] = [];

  static enqueue(messageId: string): void {
    if (!messageId) return;

    sendMessage(AUDIO_OVERVIEW_QUEUE_URL, messageId).catch((err) => {
      logger.error("Failed to enqueue Audio Overview render job", { err, messageId });
      this.memoryWait.push({ messageId, receiptHandle: null });
      this.pump();
    });
  }

  static start(): void {
    if (this.running) return;
    this.running = true;
    void this.run();
  }

  private static async run(): Promise<void> {
    const pending = await ChatRepo.listInProgressAudioOverviews().catch((err) => {
      logger.error("Audio Overview queue: failed to load IN_PROGRESS rows", { err });
      return [] as { messageId: string }[];
    });
    if (pending.length > 0) {
      logger.info("Audio Overview queue: re-queuing interrupted renders", { count: pending.length });
      this.memoryWait.push(...pending.map((row) => ({ messageId: row.messageId, receiptHandle: null })));
      this.pump();
    }

    logger.info("Audio Overview queue started", { concurrency: CONCURRENCY });
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

      const messages = await receiveMessages(AUDIO_OVERVIEW_QUEUE_URL, available, VISIBILITY_TIMEOUT_SECONDS);
      if (messages.length > 0) {
        this.memoryWait.push(...messages.map((m) => ({ messageId: m.body, receiptHandle: m.receiptHandle })));
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
    void withVisibilityHeartbeat(AUDIO_OVERVIEW_QUEUE_URL, item.receiptHandle, VISIBILITY_TIMEOUT_SECONDS, () =>
      AudioOverviewAudioSvc.process(item.messageId),
    )
      .catch((err) => {
        logger.error("Audio Overview queue: job failed", { err, messageId: item.messageId });
      })
      .finally(async () => {
        if (item.receiptHandle) {
          await deleteMessage(AUDIO_OVERVIEW_QUEUE_URL, item.receiptHandle).catch((err) => {
            logger.error("Audio Overview queue: failed to delete message", { err, messageId: item.messageId });
          });
        }
        this.active -= 1;
        this.pump();
      });
  }
}
