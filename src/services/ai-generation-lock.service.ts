import HttpError from "../utils/http-error";
import CaseAccess from "../utils/case-access";
import { AiGenerationKind } from "../constants";
import { isJobStale, isUniqueConstraintError } from "../utils/ai-generation-lock.utils";
import AiGenerationJobRepo from "../repositories/ai-generation-job.repository";
import { emitToCase } from "../lib/socket";
import logger from "../utils/logger";

/**
 * Generic "is a generation currently running" lock, shared by every Chat-Wonder-backed
 * Generate/Refresh/Scan action — see the schema comment on AiGenerationJob for why this exists
 * (a page refresh mid-generation otherwise looks idle, inviting a duplicate click/enqueue).
 */
export default class AiGenerationLockSvc {
  /**
   * Best-effort live push to every viewer of `subjectId` (a caseId) currently watching this
   * case's Terminal — see lib/socket.ts's AiJobSocketEvent/AiJobSocketPayload. Both begin() and
   * finish() below are the single choke point every one of the 8 AiGenerationQueue kinds funnels
   * through (including casePostExtraction, which calls begin() directly with no controller in
   * front of it — see case-post-extraction.ts) — so putting the emit here, once, covers all of
   * them. Wrapped in try/catch, same as DocumentExtractionSvc.emit: this is a live-UX shortcut
   * over the DB-backed GET /ai-jobs/:kind poll, which stays correct regardless of push delivery,
   * so a throwing/disconnected socket layer must never affect the lock transition itself.
   */
  private static emit(
    subjectId: string,
    event: "ai-job:started" | "ai-job:progress" | "ai-job:done" | "ai-job:failed",
    kind: AiGenerationKind,
    row: { status: string; startedAt: Date; finishedAt: Date | null; error: string | null; stage?: string | null },
  ): void {
    try {
      emitToCase(subjectId, event, {
        caseId: subjectId,
        kind,
        status: row.status,
        startedAt: row.startedAt.toISOString(),
        finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
        error: row.error,
        stage: row.stage ?? null,
      });
    } catch (err) {
      logger.warn("AiGenerationLockSvc: emitToCase failed, continuing without it", { err, event, subjectId, kind });
    }
  }

  static async getStatus(subjectId: string, kind: AiGenerationKind) {
    return AiGenerationJobRepo.findBySubjectAndKind(subjectId, kind);
  }

  /** GET /api/my-cases/:caseId/ai-jobs/:kind — case-access-checked status lookup, reused by
   * every case-scoped Generate/Refresh/Scan button's polling hook. */
  static async getStatusForCase(caseId: string, userId: string, kind: AiGenerationKind) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    const row = await this.getStatus(caseId, kind);
    // A run the server never finished (it crashed or restarted mid-run) stays IN_PROGRESS, and the
    // panel polling it would show "updating" forever. Past STALE_AFTER_MS — the same age `begin`
    // already treats as abandoned — close it out as failed so the panel offers a retry instead.
    if (row?.status === "IN_PROGRESS" && isJobStale(row.startedAt)) {
      logger.warn("AiGenerationLockSvc: closing a run that never finished", { caseId, kind, startedAt: row.startedAt });
      await this.finish(caseId, kind, "FAILED", "Interrupted: the run stopped before it finished. Try again.");
      return this.getStatus(caseId, kind);
    }
    return row;
  }

  /**
   * Marks a job IN_PROGRESS, or throws HttpError(409) if one is already running and not stale.
   * The common case (no prior row for this subject+kind) is a plain INSERT, so the database's
   * own unique constraint — not an application-level check-then-write — is what actually
   * prevents two concurrent callers from both starting a fresh job; only the rarer "reclaim a
   * finished/stale row" path does a check-then-update, which carries a narrow, low-stakes race
   * (worst case: two generations run concurrently, no worse than today's status quo).
   */
  static async begin(subjectId: string, kind: AiGenerationKind): Promise<void> {
    try {
      const row = await AiGenerationJobRepo.create(subjectId, kind);
      this.emit(subjectId, "ai-job:started", kind, row);
      return;
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
    }

    const existing = await this.getStatus(subjectId, kind);
    if (existing?.status === "IN_PROGRESS" && !isJobStale(existing.startedAt)) {
      throw new HttpError(`${kind} generation is already in progress`, 409);
    }
    const row = await AiGenerationJobRepo.markInProgress(subjectId, kind);
    this.emit(subjectId, "ai-job:started", kind, row);
  }

  /**
   * Records how far a running job has got (AiGenerationJob.stage) and pushes ai-job:progress, so
   * the UI can show real steps instead of a bare spinner — persisted, not just pushed, because a
   * page loaded mid-job reads the row and a stage can last a long time with nothing else
   * happening. Best-effort: callers fire this without awaiting the outcome, and a failure is
   * logged, never thrown, since a missed progress tick must not fail the generation itself. A
   * report for a job that has already finished is dropped (see updateStage).
   */
  static async setStage(subjectId: string, kind: AiGenerationKind, stage: string): Promise<void> {
    try {
      if (!(await AiGenerationJobRepo.updateStage(subjectId, kind, stage))) return;
      const row = await this.getStatus(subjectId, kind);
      if (row?.status === "IN_PROGRESS") this.emit(subjectId, "ai-job:progress", kind, row);
    } catch (err) {
      logger.warn("AiGenerationLockSvc: setStage failed, continuing without it", { err, subjectId, kind, stage });
    }
  }

  static async finish(
    subjectId: string,
    kind: AiGenerationKind,
    status: "DONE" | "FAILED",
    error?: string,
  ): Promise<void> {
    const row = await AiGenerationJobRepo.updateStatus(subjectId, kind, status, error);
    this.emit(subjectId, status === "DONE" ? "ai-job:done" : "ai-job:failed", kind, row);
  }

  /**
   * Wraps an existing generate/scan function: begin → run → finish(DONE) on success,
   * finish(FAILED) + rethrow on error. Every synchronous (request-thread) AI-generation call
   * site uses this instead of calling Chat Wonder directly.
   */
  static async run<T>(subjectId: string, kind: AiGenerationKind, fn: () => Promise<T>): Promise<T> {
    await this.begin(subjectId, kind);
    return this.finishWith(subjectId, kind, fn);
  }

  /**
   * Same run→finish(DONE)/finish(FAILED) wrapping as `run`, minus the `begin()` call — for a
   * job whose IN_PROGRESS row was already created synchronously (e.g. by a controller, before
   * handing off to AiGenerationQueue) and just needs the actual work run and the lock closed
   * out. Calling `run` here instead would throw 409 against the row `begin()` just created.
   */
  static async finishWith<T>(subjectId: string, kind: AiGenerationKind, fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      await this.finish(subjectId, kind, "DONE");
      return result;
    } catch (err) {
      await this.finish(subjectId, kind, "FAILED", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
}
