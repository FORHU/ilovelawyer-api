import cron, { type ScheduledTask } from "node-cron";
import { withCronLock } from "../lib/cron-lock";
import { deleteFromS3, listS3Objects } from "../utils/s3";
import { deleteTranscribeJob, listTranscribeJobs } from "../services/transcription.service";
import { DICTATION_JOB_PREFIX, DICTATION_KEY_PREFIX, DICTATION_MAX_AGE_MS } from "../services/client-dictation.service";
import logger from "../utils/logger";

/** Hourly, on the half hour. Overridable with DICTATION_SWEEP_CRON (standard 5-field cron, UTC). */
const DEFAULT_SCHEDULE = "30 * * * *";

/**
 * A cron job that deletes the dictation clips and Transcribe jobs nobody came back for: a client
 * who closed the tab or lost the network after recording never polled the result, so
 * ClientDictationSvc never got to discard them. Anything older than DICTATION_MAX_AGE_MS is past
 * any poll the app would still make (180s of recording, two minutes of polling).
 */
export default class DictationSweepQueue {
  private static task: ScheduledTask | null = null;
  private static ticking = false;

  static start(): void {
    if (this.task) return;
    const configured = process.env.DICTATION_SWEEP_CRON;
    let schedule = DEFAULT_SCHEDULE;
    if (configured) {
      if (cron.validate(configured)) schedule = configured;
      else logger.error("Dictation sweep: invalid DICTATION_SWEEP_CRON, using the default", { configured, schedule });
    }
    // withCronLock: node-cron fires on every API instance; only one runs the sweep.
    this.task = cron.schedule(
      schedule,
      () => withCronLock("dictation-sweep", async () => void (await this.tick())).catch((err) => logger.error("Dictation sweep: run failed", { err })),
      { name: "dictation-sweep", timezone: "UTC", noOverlap: true },
    );
    logger.info("Dictation sweep: cron job scheduled", { schedule });
  }

  /** One sweep. Called by the cron schedule; exposed for tests. A failed delete is logged and
   * left for the next run. */
  static async tick(now: Date = new Date()): Promise<{ clips: number; jobs: number; failed: number }> {
    const result = { clips: 0, jobs: 0, failed: 0 };
    if (this.ticking) return result;
    this.ticking = true;
    try {
      const cutoff = new Date(now.getTime() - DICTATION_MAX_AGE_MS);

      for (const clip of await listS3Objects(DICTATION_KEY_PREFIX)) {
        if (clip.lastModified >= cutoff) continue;
        try {
          await deleteFromS3(clip.key);
          result.clips++;
        } catch (err) {
          result.failed++;
          logger.warn("Dictation sweep: couldn't delete a clip", { err, key: clip.key });
        }
      }

      // Only a finished job can be deleted; one still running is picked up by a later run.
      for (const job of await listTranscribeJobs(DICTATION_JOB_PREFIX)) {
        if (job.createdAt >= cutoff || (job.status !== "COMPLETED" && job.status !== "FAILED")) continue;
        try {
          await deleteTranscribeJob(job.name);
          result.jobs++;
        } catch (err) {
          result.failed++;
          logger.warn("Dictation sweep: couldn't delete a job", { err, job: job.name });
        }
      }

      if (result.clips || result.jobs || result.failed) logger.info("Dictation sweep: run finished", result);
      return result;
    } finally {
      this.ticking = false;
    }
  }
}
