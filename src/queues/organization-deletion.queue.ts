import cron, { type ScheduledTask } from "node-cron";
import OrganizationRepo from "../repositories/organization.repository";
import SecurityAuditSvc from "../services/security-audit.service";
import AuditSvc, { AuditAction } from "../services/audit.service";
import { ORGANIZATION_DELETION_GRACE_PERIOD_DAYS } from "../constants/organization-deletion.constants";
import { withCronLock } from "../lib/cron-lock";
import logger from "../utils/logger";

/** Due organizations fetched per query. */
const PAGE_SIZE = 50;

/** Daily at 02:30 UTC, half an hour after ConsultationDeletionQueue. The grace period is counted
 * in days, so a daily run is precise enough: a deletion lands within a day of its 30 days ending,
 * never before. Overridable with ORGANIZATION_DELETION_CRON (standard 5-field cron, in UTC). */
const DEFAULT_SCHEDULE = "30 2 * * *";

/**
 * A cron job that deletes organizations archived when their last member left (status
 * PENDING_DELETION, see OrganizationRepo.archiveIfEmptyIn) once deletionScheduledAt has passed —
 * the only process that calls OrganizationRepo.deletePermanently. Until then customer support can
 * restore one by setting it back to ACTIVE.
 */
export default class OrganizationDeletionQueue {
  private static task: ScheduledTask | null = null;
  private static ticking = false;

  static start(): void {
    if (this.task) return;
    const configured = process.env.ORGANIZATION_DELETION_CRON;
    let schedule = DEFAULT_SCHEDULE;
    if (configured) {
      if (cron.validate(configured)) schedule = configured;
      else logger.error("Organization deletion: invalid ORGANIZATION_DELETION_CRON, using the default", { configured, schedule });
    }
    // withCronLock: node-cron fires on every API instance; only one runs the sweep.
    this.task = cron.schedule(
      schedule,
      () => withCronLock("organization-deletion", () => this.tick()).catch((err) => logger.error("Organization deletion: run failed", { err })),
      { name: "organization-deletion", timezone: "UTC", noOverlap: true },
    );
    logger.info("Organization deletion: cron job scheduled", { schedule, gracePeriodDays: ORGANIZATION_DELETION_GRACE_PERIOD_DAYS });
  }

  /** One sweep. Called by the cron schedule; exposed for tests. */
  static async tick(now: Date = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      // A page at a time, stepping past each page's last id — same as ConsultationDeletionQueue.
      let afterId: string | undefined;
      let page: { id: string; name: string }[];
      do {
        page = await OrganizationRepo.findDueForDeletion(now, { afterId, take: PAGE_SIZE });
        for (const { id, name } of page) {
          try {
            const result = await OrganizationRepo.deletePermanently(id);
            if (!result) continue;
            logger.info("Organization deletion: deleted organization", { organizationId: id, ...result });
            await SecurityAuditSvc.record({
              action: "org.deleted",
              actorId: null,
              organizationId: id,
              targetType: "organization",
              targetId: id,
              targetName: name,
              payload: { reason: "grace_period_elapsed", ...result },
            });
            await AuditSvc.record({ action: AuditAction.OrgDeleted, payload: { organizationId: id, ...result } });
          } catch (err) {
            // One failure mustn't stop the rest; it's still PENDING_DELETION, so the next run
            // tries it again.
            logger.error("Organization deletion: failed to delete organization", { err, organizationId: id });
          }
        }
        afterId = page.at(-1)?.id;
      } while (page.length === PAGE_SIZE);
    } catch (err) {
      logger.error("Organization deletion: run failed", { err });
    } finally {
      this.ticking = false;
    }
  }
}
