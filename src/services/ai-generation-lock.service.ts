import HttpError from "../utils/http-error";
import CaseAccess from "../utils/case-access";
import { AiGenerationKind } from "../constants";
import { isJobStale, isUniqueConstraintError } from "../utils/ai-generation-lock.utils";
import AiGenerationJobRepo from "../repositories/ai-generation-job.repository";

/**
 * Generic "is a generation currently running" lock, shared by every Chat-Wonder-backed
 * Generate/Refresh/Scan action — see the schema comment on AiGenerationJob for why this exists
 * (a page refresh mid-generation otherwise looks idle, inviting a duplicate click/enqueue).
 */
export default class AiGenerationLockSvc {
  static async getStatus(subjectId: string, kind: AiGenerationKind) {
    return AiGenerationJobRepo.findBySubjectAndKind(subjectId, kind);
  }

  /** GET /api/my-cases/:caseId/ai-jobs/:kind — case-access-checked status lookup, reused by
   * every case-scoped Generate/Refresh/Scan button's polling hook. */
  static async getStatusForCase(caseId: string, userId: string, kind: AiGenerationKind) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return this.getStatus(caseId, kind);
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
      await AiGenerationJobRepo.create(subjectId, kind);
      return;
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
    }

    const existing = await this.getStatus(subjectId, kind);
    if (existing?.status === "IN_PROGRESS" && !isJobStale(existing.startedAt)) {
      throw new HttpError(`${kind} generation is already in progress`, 409);
    }
    await AiGenerationJobRepo.markInProgress(subjectId, kind);
  }

  static async finish(
    subjectId: string,
    kind: AiGenerationKind,
    status: "DONE" | "FAILED",
    error?: string,
  ): Promise<void> {
    await AiGenerationJobRepo.updateStatus(subjectId, kind, status, error);
  }

  /**
   * Wraps an existing generate/scan function: begin → run → finish(DONE) on success,
   * finish(FAILED) + rethrow on error. Every AI-generation call site uses this instead of
   * calling Chat Wonder directly.
   */
  static async run<T>(subjectId: string, kind: AiGenerationKind, fn: () => Promise<T>): Promise<T> {
    await this.begin(subjectId, kind);
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
