import AuthRepo from "../repositories/auth.repository";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";
import { ACCOUNT_DELETION_GRACE_PERIOD_DAYS } from "../constants/account-deletion.constants";
import logger from "../utils/logger";

const POLL_INTERVAL_MS = 60 * 60 * 1000;
const GRACE_PERIOD_MS = ACCOUNT_DELETION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

/**
 * Polls for Users whose self-requested deletion grace period (see UsersSvc.requestDeletion) has
 * fully elapsed and hard-deletes them — the only process that ever turns a deletion *request*
 * into an actual `prisma.user.delete`.
 */
export default class AccountDeletionQueue {
  private static running = false;
  private static ticking = false;

  static start(): void {
    if (this.running) return;
    this.running = true;
    logger.info("Account deletion queue started", { pollIntervalMs: POLL_INTERVAL_MS });
    void this.tick();
    setInterval(() => void this.tick(), POLL_INTERVAL_MS);
  }

  private static async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const cutoff = new Date(Date.now() - GRACE_PERIOD_MS);
      const due = await AuthRepo.findDueForHardDeletion(cutoff);

      for (const user of due) {
        await this.hardDelete(user);
      }
    } catch (err) {
      logger.error("Account deletion queue: tick failed", { err });
    } finally {
      this.ticking = false;
    }
  }

  private static async hardDelete(user: { id: string; email: string; name: string | null }): Promise<void> {
    try {
      // Notify before deleting — the User row (and its email address) won't exist to read afterward.
      const html = await renderTemplate("account-deleted", {
        name: user.name || "there",
        gracePeriodDays: String(ACCOUNT_DELETION_GRACE_PERIOD_DAYS),
      });
      await sendEmail({ to: user.email, subject: "Your ilovelawyer account has been deleted", html }).catch((err) =>
        logger.error("Account deletion queue: failed to send account-deleted email", { err, userId: user.id }),
      );

      await AuthRepo.deleteSessionsByUserId(user.id);
      await AuthRepo.deleteUser(user.id);
      logger.info("Account deletion queue: hard-deleted user", { userId: user.id });
    } catch (err) {
      logger.error("Account deletion queue: failed to hard-delete user", { err, userId: user.id });
    }
  }
}
