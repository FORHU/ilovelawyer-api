import cron, { type ScheduledTask } from "node-cron";
import SecurityAuditRepo from "../repositories/security-audit.repository";
import { securityAuditRetentionDays } from "../constants/security-audit.constants";
import { withCronLock } from "../lib/cron-lock";
import logger from "../utils/logger";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows deleted per statement, so a large first sweep never holds one huge delete. */
const BATCH_SIZE = 1000;

/** Daily at 03:00 UTC, an hour after the deletion sweeps. Overridable with
 * SECURITY_AUDIT_RETENTION_CRON (standard 5-field cron, evaluated in UTC). */
const DEFAULT_SCHEDULE = "0 3 * * *";

/**
 * Deletes security audit rows older than the retention period (securityAuditRetentionDays) — the
 * only process that removes them. The database refuses to delete anything younger than the
 * 365-day floor whatever this is configured to (see the security_audit_event migration).
 */
export default class SecurityAuditRetentionQueue {
  private static task: ScheduledTask | null = null;
  private static ticking = false;

  static start(): void {
    if (this.task) return;
    const configured = process.env.SECURITY_AUDIT_RETENTION_CRON;
    let schedule = DEFAULT_SCHEDULE;
    if (configured) {
      if (cron.validate(configured)) schedule = configured;
      else logger.error("Security audit retention: invalid SECURITY_AUDIT_RETENTION_CRON, using the default", { configured, schedule });
    }
    this.task = cron.schedule(
      schedule,
      () =>
        withCronLock("security-audit-retention", async () => void (await this.tick())).catch((err) =>
          logger.error("Security audit retention: run failed", { err }),
        ),
      { name: "security-audit-retention", timezone: "UTC", noOverlap: true },
    );
    logger.info("Security audit retention: cron job scheduled", { schedule, retentionDays: securityAuditRetentionDays() });
  }

  /** One sweep. Called by the cron schedule; exposed for tests. */
  static async tick(now: Date = new Date()): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    const retentionDays = securityAuditRetentionDays();
    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
    let deleted = 0;
    try {
      let batch: number;
      do {
        batch = await SecurityAuditRepo.deleteOlderThan(cutoff, BATCH_SIZE);
        deleted += batch;
      } while (batch === BATCH_SIZE);
    } catch (err) {
      logger.error("Security audit retention: run failed", { err, deleted });
    } finally {
      this.ticking = false;
      logger.info("Security audit retention: run finished", { deleted, retentionDays, cutoff: cutoff.toISOString() });
    }
    return deleted;
  }
}
