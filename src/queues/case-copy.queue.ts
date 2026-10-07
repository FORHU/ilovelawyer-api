import cron, { type ScheduledTask } from "node-cron";
import CaseCopyRepo from "../repositories/case-copy.repository";
import CaseCopySvc, { CaseCopyAbandoned } from "../services/case-copy.service";
import logger from "../utils/logger";

/** A copy is given up on (FAILED) after this many tries. */
const MAX_ATTEMPTS = 3;
/** Copies taken per sweep. */
const BATCH = 20;
/** RUNNING longer than this means the process working on it died — put it back in the queue. */
const STALE_RUNNING_MS = 30 * 60_000;

/**
 * Works through queued portfolio copies (CaseCopy and ConsultationCopy rows, written when a
 * member leaves an organization — see OrganizationSvc). Sweeps every minute, and OrganizationSvc
 * kicks it right after a leave so copies usually start at once. Each row is claimed atomically
 * (CaseCopyRepo.claim), so every API instance can sweep without doing the same copy twice.
 */
export default class CaseCopyQueue {
  private static task: ScheduledTask | null = null;
  private static ticking = false;

  static start(): void {
    if (this.task) return;
    this.task = cron.schedule("* * * * *", () => void this.tick(), { name: "case-copy", noOverlap: true });
    logger.info("Case copy: cron job scheduled");
  }

  /** Starts a sweep now without waiting for it — only once start() has run (the server; tests
   * call tick() themselves). */
  static kick(): void {
    if (this.task) void this.tick();
  }

  /** One sweep. Exposed for tests. */
  static async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const requeued = await CaseCopyRepo.requeueStale(new Date(Date.now() - STALE_RUNNING_MS));
      if (requeued) logger.warn("Case copy: requeued copies left running", { requeued });

      let ids: string[];
      do {
        ids = await CaseCopyRepo.listPendingIds(BATCH);
        for (const id of ids) await this.process(id);
      } while (ids.length === BATCH);
      do {
        ids = await CaseCopyRepo.listPendingConsultationIds(BATCH);
        for (const id of ids) await this.processConsultation(id);
      } while (ids.length === BATCH);
    } catch (err) {
      logger.error("Case copy: sweep failed", { err });
    } finally {
      this.ticking = false;
    }
  }

  private static async process(id: string): Promise<void> {
    const job = await CaseCopyRepo.claim(id);
    if (!job) return; // another instance took it
    try {
      const copyCaseId = await CaseCopySvc.copy(job);
      await CaseCopyRepo.markDone(id, copyCaseId);
      logger.info("Case copy: copied case to portfolio", { copyId: id, sourceCaseId: job.sourceCaseId, copyCaseId });
    } catch (err) {
      const retry = !(err instanceof CaseCopyAbandoned) && job.attempts < MAX_ATTEMPTS;
      await CaseCopyRepo.markFailed(id, err instanceof Error ? err.message : String(err), retry);
      logger.error("Case copy: copy failed", { err, copyId: id, sourceCaseId: job.sourceCaseId, willRetry: retry });
    }
  }

  private static async processConsultation(id: string): Promise<void> {
    const job = await CaseCopyRepo.claimConsultation(id);
    if (!job) return; // another instance took it
    try {
      const copyConsultationId = await CaseCopySvc.copyConsultation(job);
      await CaseCopyRepo.markConsultationDone(id, copyConsultationId);
      logger.info("Case copy: copied consultation to portfolio", { copyId: id, sourceConsultationId: job.sourceConsultationId, copyConsultationId });
    } catch (err) {
      const retry = !(err instanceof CaseCopyAbandoned) && job.attempts < MAX_ATTEMPTS;
      await CaseCopyRepo.markConsultationFailed(id, err instanceof Error ? err.message : String(err), retry);
      logger.error("Case copy: consultation copy failed", { err, copyId: id, sourceConsultationId: job.sourceConsultationId, willRetry: retry });
    }
  }
}
