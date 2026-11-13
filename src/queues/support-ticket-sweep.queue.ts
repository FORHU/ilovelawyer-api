import cron, { type ScheduledTask } from "node-cron";
import SupportTicketSvc from "../services/support-ticket.service";
import { withCronLock } from "../lib/cron-lock";
import logger from "../utils/logger";

/** Hourly: a ticket left a few minutes past its seventh day is nothing anyone would notice. */
const SCHEDULE = "17 * * * *";

/**
 * Resolves Support Tickets the client never answered: ANSWERED for 7 days with no reply from them
 * (SupportTicketSvc.autoResolveDue). A client reply makes a ticket OPEN again, so an ANSWERED one is by
 * definition unanswered. Each ticket is a guarded update, so overlapping runs never resolve one twice.
 */
export default class SupportTicketSweepQueue {
  private static task: ScheduledTask | null = null;
  private static ticking = false;

  static start(): void {
    if (this.task) return;
    this.task = cron.schedule(
      SCHEDULE,
      () => withCronLock("support-ticket-sweep", async () => void (await this.tick())).catch((err) => logger.error("Support ticket sweep: run failed", { err })),
      { name: "support-ticket-sweep", timezone: "UTC", noOverlap: true },
    );
    logger.info("Support ticket sweep: cron job scheduled", { schedule: SCHEDULE });
  }

  /** One sweep. Called by the cron schedule; exposed for tests. */
  static async tick(now: Date = new Date()): Promise<{ resolved: number }> {
    if (this.ticking) return { resolved: 0 };
    this.ticking = true;
    try {
      const resolved = await SupportTicketSvc.autoResolveDue(now);
      if (resolved > 0) logger.info("Support ticket sweep: resolved unanswered tickets", { resolved });
      return { resolved };
    } catch (err) {
      logger.error("Support ticket sweep: failed", { err });
      return { resolved: 0 };
    } finally {
      this.ticking = false;
    }
  }
}
