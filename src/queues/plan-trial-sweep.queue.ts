import cron, { type ScheduledTask } from "node-cron";
import PlanTrialSvc from "../services/plan-trial.service";
import { withCronLock } from "../lib/cron-lock";
import logger from "../utils/logger";

/** Hourly: a trial is days long, so an email up to an hour after the moment is on time. */
const SCHEDULE = "0 * * * *";

type SweepResult = { reminded: number; ended: number };

/**
 * The solo lawyer free trial's emails (PlanTrialSvc): the "ends soon" reminder, then the "has
 * ended" notice. The lock itself needs no job — AccountLimitsSvc checks the end date on every
 * request. One step failing doesn't stop the other.
 */
export default class PlanTrialSweepQueue {
  private static task: ScheduledTask | null = null;
  private static ticking = false;

  static start(): void {
    if (this.task) return;
    this.task = cron.schedule(
      SCHEDULE,
      () => withCronLock("plan-trial-sweep", async () => void (await this.tick())).catch((err) => logger.error("Plan trial sweep: run failed", { err })),
      { name: "plan-trial-sweep", timezone: "UTC", noOverlap: true },
    );
    logger.info("Plan trial sweep: cron job scheduled", { schedule: SCHEDULE });
  }

  /** One sweep. Called by the cron schedule; exposed for tests. */
  static async tick(now: Date = new Date()): Promise<SweepResult> {
    const result: SweepResult = { reminded: 0, ended: 0 };
    if (this.ticking) return result;
    this.ticking = true;
    try {
      result.reminded = await this.step("remind", () => PlanTrialSvc.remindDue(now));
      result.ended = await this.step("ended", () => PlanTrialSvc.announceEnded(now));
    } finally {
      this.ticking = false;
    }
    if (result.reminded || result.ended) logger.info("Plan trial sweep: run finished", result);
    return result;
  }

  /** One step of the run: a failure is logged and counts as nothing done, so the other still runs. */
  private static async step(name: string, run: () => Promise<number>): Promise<number> {
    try {
      return await run();
    } catch (err) {
      logger.error("Plan trial sweep: step failed", { step: name, err });
      return 0;
    }
  }
}
