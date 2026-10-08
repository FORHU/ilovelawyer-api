import { randomUUID } from "crypto";
import CaseChangeSummaryRepo from "../repositories/case-change-summary.repository";
import CaseRepo from "../repositories/case.repository";
import { CaseChangeDeltas, CaseChangePane, CaseChangeReason, ChangedDocument, PaneNotRun } from "../types/case-change";
import { countChanges } from "../utils/case-change-delta";
import { diffDocumentIds, mindMapDocumentIds } from "../utils/ready-set-fingerprint";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

type Delta<P extends CaseChangePane> = NonNullable<CaseChangeDeltas[P]>;

type RunDocument = { id: string; name: string; ragStatus: string; status?: string | null };

/**
 * What one run changed, pane by pane, saved as one CaseChangeSummary. Two kinds of run write one:
 * the analysis refresh (CaseRefreshSvc — every tracked pane, collected while its steps run), and a
 * single pane's own Regenerate (ADR 0018 — that pane alone, see `regenerate`). `id` is the run's
 * id and becomes the summary's.
 *
 * Tracking never changes how a step runs: the step's result and its errors pass through untouched.
 * A read or comparison that fails only loses that pane's delta.
 */
export default class CaseChangeRun {
  readonly id = randomUUID();
  /** When the run began — lawyers' edits after the previous run and before this are "edits since
   * the previous run"; edits made while it worked aren't. */
  readonly startedAt = new Date();
  private readonly deltas: CaseChangeDeltas = {};
  private readonly captured = new Map<CaseChangePane, unknown>();

  constructor(private readonly caseId: string) {}

  /**
   * A pane's own Regenerate: compares the pane before and after `run` and saves a summary of that
   * pane alone, so the modal stops describing what the last refresh said about it. Call it inside
   * the job's finishWith callback — the summary then exists before the job reads as DONE and the
   * app refetches the snapshot. A run that throws saves nothing (the pane shows its own failure)
   * and rethrows.
   */
  static async regenerate<P extends CaseChangePane, S, R>(
    caseId: string,
    actorId: string | null,
    pane: P,
    read: () => Promise<S>,
    run: () => Promise<R>,
    diff: (before: S, after: S, result: R) => Delta<P>,
  ): Promise<R> {
    const changes = new CaseChangeRun(caseId);
    const result = await changes.compare(pane, read, run, diff);
    await changes.saveRegenerate(actorId);
    return result;
  }

  /** Records a pane's delta computed by the step itself (the contradictions scan does). */
  record<P extends CaseChangePane>(pane: P, delta: Delta<P>): void {
    this.deltas[pane] = delta;
  }

  /** Runs a step, marking its pane skipped (409: the pane's own job holds its lock) or failed
   * when it throws, then rethrows for CaseRefreshSvc.runStep to log. */
  async track<R>(pane: CaseChangePane, run: () => Promise<R>): Promise<R> {
    try {
      return await run();
    } catch (err) {
      this.deltas[pane] = { status: err instanceof HttpError && err.statusCode === 409 ? "skipped" : "failed" } satisfies PaneNotRun;
      throw err;
    }
  }

  /** Reads the pane, runs the step, reads the pane again and records `diff(before, after, result)`. */
  async compare<P extends CaseChangePane, S, R>(
    pane: P,
    read: () => Promise<S>,
    run: () => Promise<R>,
    diff: (before: S, after: S, result: R) => Delta<P>,
  ): Promise<R> {
    const before = await this.attempt(pane, "read before", read);
    const result = await this.track(pane, run);
    if (before.ok) {
      const after = await this.attempt(pane, "read after", read);
      if (after.ok) {
        const delta = await this.attempt(pane, "compare", async () => diff(before.value, after.value, result));
        if (delta.ok) this.deltas[pane] = delta.value;
      }
    }
    return result;
  }

  /** For a pane more than one step writes (witnesses, damages: read new documents in one wave,
   * score or re-rate in the next) — reads it before the first step; `settle` compares after the
   * last. The steps themselves run through `track`. */
  async capture<S>(pane: CaseChangePane, read: () => Promise<S>): Promise<void> {
    const before = await this.attempt(pane, "read before", read);
    if (before.ok) this.captured.set(pane, before.value);
  }

  /** Compares a `capture`d pane with how it reads now. A step that failed or was skipped keeps
   * that status — unless the pane still changed (the other step did its part), and then what
   * changed is shown. */
  async settle<P extends CaseChangePane, S>(pane: P, read: () => Promise<S>, diff: (before: S, after: S) => Delta<P>): Promise<void> {
    if (!this.captured.has(pane)) return;
    const before = this.captured.get(pane) as S;
    const after = await this.attempt(pane, "read after", read);
    if (!after.ok) return;
    const delta = await this.attempt(pane, "compare", async () => diff(before, after.value));
    if (!delta.ok) return;
    if (this.deltas[pane] && delta.value.status !== "changed") return;
    this.deltas[pane] = delta.value;
  }

  /** Saves a refresh's summary. Never throws — a lost summary must not fail the refresh it
   * describes. `documents` is the case's document list as the run read it. Call before
   * CaseRepo.markRefreshed: a case never refreshed before, with no earlier refresh summary, is on
   * its first analysis. */
  async save(input: {
    reason: Exclude<CaseChangeReason, "regenerate">;
    actorId: string | null;
    documents: RunDocument[];
  }): Promise<{ id: string; totalChanges: number } | null> {
    try {
      const readyDocumentIds = mindMapDocumentIds(input.documents);
      // "New documents" are new since the last refresh — a pane Regenerate in between read no new
      // evidence and records no documents, so it is never the baseline.
      const [previous, lastRefreshedAt] = await Promise.all([
        CaseChangeSummaryRepo.latestRefresh(this.caseId),
        CaseRepo.getLastRefreshedAt(this.caseId),
      ]);
      // A case's first summary has nothing to compare with, so no document is "new" to it.
      const { added, removed } = previous ? diffDocumentIds(previous.readyDocumentIds, readyDocumentIds) : { added: [], removed: [] };
      const names = new Map(input.documents.map((d) => [d.id, d.name]));
      const named = (ids: string[]): ChangedDocument[] => ids.map((id) => ({ id, name: names.get(id) ?? null }));
      return await this.persist({
        reason: input.reason,
        actorId: input.actorId,
        readyDocumentIds,
        documentsAdded: named(added),
        documentsRemoved: named(removed),
        firstAnalysis: !previous && !lastRefreshedAt,
      });
    } catch (err) {
      logger.warn("Change summary not saved", { err, caseId: this.caseId, id: this.id });
      return null;
    }
  }

  /** Saves a pane Regenerate's summary — none when the comparison was lost (a failed read), since
   * a modal naming no pane would say nothing. Never throws. */
  private async saveRegenerate(actorId: string | null): Promise<void> {
    if (Object.keys(this.deltas).length === 0) return;
    try {
      await this.persist({
        reason: "regenerate",
        actorId,
        readyDocumentIds: [],
        documentsAdded: [],
        documentsRemoved: [],
        firstAnalysis: false,
      });
    } catch (err) {
      logger.warn("Change summary not saved", { err, caseId: this.caseId, id: this.id });
    }
  }

  private async persist(row: {
    reason: CaseChangeReason;
    actorId: string | null;
    readyDocumentIds: string[];
    documentsAdded: ChangedDocument[];
    documentsRemoved: ChangedDocument[];
    firstAnalysis: boolean;
  }): Promise<{ id: string; totalChanges: number }> {
    const totalChanges = countChanges(this.deltas);
    await CaseChangeSummaryRepo.create({
      id: this.id,
      caseId: this.caseId,
      ...row,
      totalChanges,
      perPaneDeltas: this.deltas,
      startedAt: this.startedAt,
    });
    logger.info("Change summary saved", {
      caseId: this.caseId,
      id: this.id,
      reason: row.reason,
      totalChanges,
      documentsAdded: row.documentsAdded.length,
      documentsRemoved: row.documentsRemoved.length,
      panes: Object.fromEntries(Object.entries(this.deltas).map(([pane, d]) => [pane, d.status])),
    });
    return { id: this.id, totalChanges };
  }

  private async attempt<T>(pane: CaseChangePane, what: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      logger.warn(`Change tracking: ${pane} failed (${what})`, { err, caseId: this.caseId });
      return { ok: false };
    }
  }
}
