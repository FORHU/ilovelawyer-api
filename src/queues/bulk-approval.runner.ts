import AdminSvc from "../services/admin.service";
import AuthRepo from "../repositories/auth.repository";
import OrganizationRepo from "../repositories/organization.repository";
import TenantRepo from "../repositories/tenant.repository";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { redis } from "../lib/redis";
import type { TenantCode } from "../types/tenant-code";
import { BULK_APPROVE_CONCURRENCY, BULK_APPROVE_LOCK_TTL_S, BULK_APPROVE_PROGRESS_TTL_S } from "../constants";

export interface BulkApprovalProgress {
  status: "running" | "done";
  total: number;
  done: number;
  approved: number;
  // Moved out of PENDING by someone else mid-run (AdminSvc.approve's 409) — not an error.
  skipped: number;
  failed: number;
  startedById: string;
  startedAt: string;
  finishedAt: string | null;
}

const lockKey = (code: TenantCode) => `bulk-approve:${code}:lock`;
const progressKey = (code: TenantCode) => `bulk-approve:${code}:progress`;

/**
 * "Approve all pending" for one Tenant: runs every approvable PENDING user through the same
 * AdminSvc.approve a manual click uses (session wipe, login link, signup-approved email), in
 * the background so the request doesn't wait on hundreds of emails. A Redis lock keeps it to
 * one run per Tenant; progress lives in Redis for the admin Settings page to poll.
 *
 * Nothing is persisted beyond that — if the process dies mid-run the lock expires with its
 * TTL and the remaining users are still PENDING, so starting again simply picks them up.
 */
export default class BulkApprovalRunner {
  static async getProgress(code: TenantCode) {
    return redis.get<BulkApprovalProgress>(progressKey(code));
  }

  /** Starts a run and returns right away with how many users it will process. */
  static async start(code: TenantCode, adminId: string): Promise<{ total: number }> {
    const tenant = await TenantRepo.findByCode(code);
    if (!tenant) throw new HttpError(`Unknown tenant ${code}`, 404);

    const acquired = await redis.setIfAbsent(lockKey(code), { adminId }, BULK_APPROVE_LOCK_TTL_S);
    // Without Redis there's no lock, so two runs could overlap on the same users — refuse
    // rather than guess.
    if (acquired === null) throw new HttpError("Bulk approval is unavailable right now. Try again shortly.", 503);
    if (!acquired) throw new HttpError(`An approval run for ${code} is already in progress`, 409);

    let ids: string[];
    try {
      ids = await AuthRepo.findApprovablePendingIds(tenant.id);
    } catch (err) {
      await redis.del(lockKey(code));
      throw err;
    }

    if (ids.length === 0) {
      await redis.del(lockKey(code));
      return { total: 0 };
    }

    const progress: BulkApprovalProgress = {
      status: "running",
      total: ids.length,
      done: 0,
      approved: 0,
      skipped: 0,
      failed: 0,
      startedById: adminId,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    await redis.set(progressKey(code), progress, BULK_APPROVE_PROGRESS_TTL_S);

    void BulkApprovalRunner.run(code, ids, progress);
    return { total: ids.length };
  }

  private static async run(code: TenantCode, ids: string[], progress: BulkApprovalProgress) {
    try {
      for (let i = 0; i < ids.length; i += BULK_APPROVE_CONCURRENCY) {
        const batch = ids.slice(i, i + BULK_APPROVE_CONCURRENCY);
        const results = await Promise.allSettled(batch.map((id) => AdminSvc.approve(id)));

        results.forEach((result, idx) => {
          if (result.status === "fulfilled") {
            progress.approved++;
          } else if (result.reason instanceof HttpError && [404, 409].includes(result.reason.statusCode)) {
            // Approved/denied by hand (409) or deleted (404) since the snapshot was taken.
            progress.skipped++;
          } else {
            progress.failed++;
            logger.error("Bulk approval: failed to approve user", { err: result.reason, userId: batch[idx], tenant: code });
          }
        });
        progress.done += batch.length;

        await redis.set(progressKey(code), progress, BULK_APPROVE_PROGRESS_TTL_S);
        await redis.set(lockKey(code), { adminId: progress.startedById }, BULK_APPROVE_LOCK_TTL_S);
      }
    } catch (err) {
      logger.error("Bulk approval: run aborted", { err, tenant: code });
    } finally {
      progress.status = "done";
      progress.finishedAt = new Date().toISOString();
      await redis.set(progressKey(code), progress, BULK_APPROVE_PROGRESS_TTL_S);
      await redis.del(lockKey(code));

      await OrganizationRepo.writeAudit({
        actorId: progress.startedById,
        action: "users.bulk_approved",
        payload: {
          tenant: code,
          total: progress.total,
          approved: progress.approved,
          skipped: progress.skipped,
          failed: progress.failed,
        },
      }).catch((err) => logger.error("Bulk approval: failed to write audit event", { err, tenant: code }));
    }
  }
}
