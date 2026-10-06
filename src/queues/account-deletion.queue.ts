import cron, { type ScheduledTask } from "node-cron";
import AuthRepo from "../repositories/auth.repository";
import AccountDeletionSvc from "../services/account-deletion.service";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";
import { ACCOUNT_DELETION_GRACE_PERIOD_DAYS } from "../constants/account-deletion.constants";
import { withCronLock } from "../lib/cron-lock";
import logger from "../utils/logger";

const GRACE_PERIOD_MS = ACCOUNT_DELETION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
/** Due users fetched per query. */
const PAGE_SIZE = 100;

/** Daily at 02:00 UTC, same as ConsultationDeletionQueue. The grace period is counted in days,
 * so a daily run is precise enough: a purge lands within a day of its 30 days ending, never
 * before. Overridable with ACCOUNT_DELETION_CRON (standard 5-field cron, evaluated in UTC). */
const DEFAULT_SCHEDULE = "0 2 * * *";

/**
 * A cron job that hard-deletes Users whose self-requested deletion (see UsersSvc.requestDeletion)
 * has waited out the grace period — the only process that turns a deletion *request* into an
 * actual delete. Signing in clears the request (AccountDeletionSvc.restoreOnSignIn), so each
 * purge re-checks right before acting.
 */
export default class AccountDeletionQueue {
  private static task: ScheduledTask | null = null;
  private static ticking = false;

  static start(): void {
    if (this.task) return;
    const configured = process.env.ACCOUNT_DELETION_CRON;
    let schedule = DEFAULT_SCHEDULE;
    if (configured) {
      if (cron.validate(configured)) schedule = configured;
      else logger.error("Account deletion: invalid ACCOUNT_DELETION_CRON, using the default", { configured, schedule });
    }
    // withCronLock: node-cron fires on every API instance; only one runs the sweep.
    this.task = cron.schedule(
      schedule,
      () => withCronLock("account-deletion", () => this.tick()).catch((err) => logger.error("Account deletion: run failed", { err })),
      { name: "account-deletion", timezone: "UTC", noOverlap: true },
    );
    logger.info("Account deletion: cron job scheduled", { schedule, gracePeriodDays: ACCOUNT_DELETION_GRACE_PERIOD_DAYS });
  }

  /** One sweep. Called by the cron schedule; exposed for tests. */
  static async tick(now: Date = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const startedAt = Date.now();
    const summary = { purged: 0, skipped: 0, failed: 0 };
    try {
      const cutoff = new Date(now.getTime() - GRACE_PERIOD_MS);
      // A page at a time, so a large backlog never loads every due row at once. The next page
      // starts after this page's last id: purged rows are gone by then, and a failed one is
      // stepped past rather than fetched again in a loop.
      let afterId: string | undefined;
      let page: { id: string; email: string; name: string | null }[];
      do {
        page = await AuthRepo.findDueForHardDeletion(cutoff, { afterId, take: PAGE_SIZE });
        for (const user of page) {
          try {
            const deleted = await AccountDeletionSvc.purgeIfStillDue(user.id, cutoff);
            if (!deleted) {
              summary.skipped++;
              logger.info("Account deletion: skipped a user who restored their account", { userId: user.id });
              continue;
            }
            summary.purged++;
            // Sent only once the row is really gone — a user who signed in at the last moment
            // never gets it. The address and name were read with the page.
            const html = await renderTemplate("account-deleted", {
              name: user.name || "there",
              gracePeriodDays: String(ACCOUNT_DELETION_GRACE_PERIOD_DAYS),
            });
            await sendEmail({ to: user.email, subject: "Your ilovelawyer account has been deleted", html }).catch((err) =>
              logger.error("Account deletion: failed to send account-deleted email", { err, userId: user.id }),
            );
          } catch (err) {
            // One failure mustn't stop the rest; the request is still set, so the next run retries.
            summary.failed++;
            logger.error("Account deletion: failed to hard-delete user", { err, userId: user.id });
          }
        }
        afterId = page.at(-1)?.id;
      } while (page.length === PAGE_SIZE);
    } catch (err) {
      logger.error("Account deletion: run failed", { err });
    } finally {
      this.ticking = false;
      logger.info("Account deletion: run finished", { ...summary, durationMs: Date.now() - startedAt });
    }
  }
}
