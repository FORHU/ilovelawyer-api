import cron, { type ScheduledTask } from "node-cron";
import TrialSvc from "../services/trial.service";
import { withCronLock } from "../lib/cron-lock";
import logger from "../utils/logger";

/** Every third day at 03:30 UTC (the 1st, 4th, 7th... of the month). A guest's trial lasts hours,
 * so an expired one waits at most about three days. Overridable with TRIAL_GUEST_PURGE_CRON
 * (standard 5-field cron, in UTC). */
const DEFAULT_SCHEDULE = "30 3 */3 * *";

/**
 * A cron job that deletes landing-page trial guests whose trial has ended, with their workspace
 * and everything in it (TrialSvc.purgeExpired). scripts/purge-trial-users does the same on demand.
 */
export default class TrialGuestPurgeQueue {
  private static task: ScheduledTask | null = null;

  static start(): void {
    if (this.task) return;
    const configured = process.env.TRIAL_GUEST_PURGE_CRON;
    let schedule = DEFAULT_SCHEDULE;
    if (configured) {
      if (cron.validate(configured)) schedule = configured;
      else logger.error("Trial guest purge: invalid TRIAL_GUEST_PURGE_CRON, using the default", { configured, schedule });
    }
    // withCronLock: node-cron fires on every API instance; only one runs the sweep.
    this.task = cron.schedule(
      schedule,
      () =>
        withCronLock("trial-guest-purge", async () => {
          const deleted = await TrialSvc.purgeExpired();
          if (deleted) logger.info("Trial guest purge: deleted expired guests", { deleted });
        }).catch((err) => logger.error("Trial guest purge: run failed", { err })),
      { name: "trial-guest-purge", timezone: "UTC", noOverlap: true },
    );
    logger.info("Trial guest purge: cron job scheduled", { schedule });
  }
}
