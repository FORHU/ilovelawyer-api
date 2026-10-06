import cron, { type ScheduledTask } from "node-cron";
import ChatRepo from "../repositories/chat.repository";
import { CONSULTATION_DELETION_GRACE_PERIOD_DAYS } from "../constants/consultation-deletion.constants";
import { withCronLock } from "../lib/cron-lock";
import logger from "../utils/logger";

const GRACE_PERIOD_MS = CONSULTATION_DELETION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
/** Due consultations fetched per query. */
const PAGE_SIZE = 100;

/** Daily at 02:00 UTC. The grace period is counted in days ("Deletes in N days"), so a daily run
 * is precise enough: a purge lands within a day of its 30 days ending, never before. Overridable
 * with CONSULTATION_DELETION_CRON (standard 5-field cron, evaluated in UTC). */
const DEFAULT_SCHEDULE = "0 2 * * *";

/**
 * A cron job that purges FOR_DELETION Consultations (see ChatSvc.deleteConsultation) once they
 * have waited out the grace period — the only process that turns a deletion *request* into
 * ChatRepo.deleteConsultationPermanently. Until then they stay FOR_DELETION, restorable.
 */
export default class ConsultationDeletionQueue {
  private static task: ScheduledTask | null = null;
  private static ticking = false;

  static start(): void {
    if (this.task) return;
    const configured = process.env.CONSULTATION_DELETION_CRON;
    let schedule = DEFAULT_SCHEDULE;
    if (configured) {
      if (cron.validate(configured)) schedule = configured;
      else logger.error("Consultation deletion: invalid CONSULTATION_DELETION_CRON, using the default", { configured, schedule });
    }
    // withCronLock: node-cron fires on every API instance; only one runs the sweep.
    this.task = cron.schedule(
      schedule,
      () => withCronLock("consultation-deletion", () => this.tick()).catch((err) => logger.error("Consultation deletion: run failed", { err })),
      { name: "consultation-deletion", timezone: "UTC", noOverlap: true },
    );
    logger.info("Consultation deletion: cron job scheduled", { schedule, gracePeriodDays: CONSULTATION_DELETION_GRACE_PERIOD_DAYS });
  }

  /** One sweep. Called by the cron schedule; exposed for tests. */
  static async tick(now: Date = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const cutoff = new Date(now.getTime() - GRACE_PERIOD_MS);
      // A page at a time, so a large backlog never loads every due row at once. The next page
      // starts after this page's last id: purged rows are gone by then, and a failed one is
      // stepped past rather than fetched again in a loop.
      // A full page means there may be more after it; a short one means this was the last.
      let afterId: string | undefined;
      let page: { id: string }[];
      do {
        page = await ChatRepo.findConsultationsDueForDeletion(cutoff, { afterId, take: PAGE_SIZE });
        for (const { id } of page) {
          try {
            const { filesMarkedForDeletion } = await ChatRepo.deleteConsultationPermanently(id);
            logger.info("Consultation deletion: purged consultation", { consultationId: id, filesMarkedForDeletion });
          } catch (err) {
            // One failure (e.g. it was deleted another way meanwhile) mustn't stop the rest; it's
            // still FOR_DELETION, so the next run tries it again.
            logger.error("Consultation deletion: failed to purge consultation", { err, consultationId: id });
          }
        }
        afterId = page.at(-1)?.id;
      } while (page.length === PAGE_SIZE);
    } catch (err) {
      logger.error("Consultation deletion: run failed", { err });
    } finally {
      this.ticking = false;
    }
  }
}
