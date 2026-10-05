import ChatRepo from "../repositories/chat.repository";
import { CONSULTATION_DELETION_GRACE_PERIOD_DAYS } from "../constants/consultation-deletion.constants";
import logger from "../utils/logger";

const POLL_INTERVAL_MS = 60 * 60 * 1000;
const GRACE_PERIOD_MS = CONSULTATION_DELETION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

/**
 * Polls for FOR_DELETION Consultations (see ChatSvc.deleteConsultation) that have waited out the
 * grace period, and purges them — the only process that turns a deletion
 * *request* into ChatRepo.deleteConsultationPermanently. Same shape as AccountDeletionQueue.
 */
export default class ConsultationDeletionQueue {
  private static running = false;
  private static ticking = false;

  static start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
    setInterval(() => void this.tick(), POLL_INTERVAL_MS);
  }

  /** Exposed for tests; runs one sweep. */
  static async tick(now: Date = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const cutoff = new Date(now.getTime() - GRACE_PERIOD_MS);
      const due = await ChatRepo.findConsultationsDueForDeletion(cutoff);
      for (const { id } of due) {
        try {
          const { filesMarkedForDeletion } = await ChatRepo.deleteConsultationPermanently(id);
          logger.info("Consultation deletion queue: purged consultation", { consultationId: id, filesMarkedForDeletion });
        } catch (err) {
          // One failure (e.g. it was deleted another way meanwhile) mustn't stop the rest.
          logger.error("Consultation deletion queue: failed to purge consultation", { err, consultationId: id });
        }
      }
    } catch (err) {
      logger.error("Consultation deletion queue: tick failed", { err });
    } finally {
      this.ticking = false;
    }
  }
}
