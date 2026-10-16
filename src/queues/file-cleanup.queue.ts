import cron, { type ScheduledTask } from "node-cron";
import FileCleanupSvc from "../services/file-cleanup.service";
import { withCronLock } from "../lib/cron-lock";
import { isDev } from "../config";
import logger from "../utils/logger";

/** Every third day at 04:00 UTC, half an hour after TrialGuestPurgeQueue, so files it frees go the
 * same night. Overridable with FILE_CLEANUP_CRON (standard 5-field cron, in UTC). */
const DEFAULT_SCHEDULE = "0 4 */3 * *";

/**
 * A cron job that deletes from S3, and then from the database, every file the app has marked
 * FOR_DELETION and nothing references any more (FileCleanupSvc.sweep).
 *
 * Off on a developer machine unless FILE_CLEANUP_ENABLED=true: local databases share the dev
 * bucket, so a laptop's sweep must not delete objects on its own say-so.
 */
export default class FileCleanupQueue {
  private static task: ScheduledTask | null = null;

  static start(): void {
    if (this.task) return;
    if (isDev && process.env.FILE_CLEANUP_ENABLED !== "true") {
      logger.info("File cleanup: off in development (set FILE_CLEANUP_ENABLED=true to run it)");
      return;
    }
    const configured = process.env.FILE_CLEANUP_CRON;
    let schedule = DEFAULT_SCHEDULE;
    if (configured) {
      if (cron.validate(configured)) schedule = configured;
      else logger.error("File cleanup: invalid FILE_CLEANUP_CRON, using the default", { configured, schedule });
    }
    // withCronLock: node-cron fires on every API instance; only one runs the sweep.
    this.task = cron.schedule(
      schedule,
      () =>
        withCronLock("file-cleanup", async () => {
          const removed = await FileCleanupSvc.sweep();
          if (removed) logger.info("File cleanup: removed files", { removed });
        }).catch((err) => logger.error("File cleanup: run failed", { err })),
      { name: "file-cleanup", timezone: "UTC", noOverlap: true },
    );
    logger.info("File cleanup: cron job scheduled", { schedule });
  }
}
