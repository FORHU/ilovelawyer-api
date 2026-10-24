import type { OverviewPane, SectionStatus } from "../types/client-overview";
import type { ClientOverviewPanes } from "../repositories/client-overview.repository";

export interface SectionStatusInput {
  /** The pane whose output this section shows. */
  pane: OverviewPane;
  /** The panes the live job has finished so far, or null when no job is running. The caller has
   * already filtered the job for staleness (isJobStale): a lost run reads as not running. */
  runningPanesDone: OverviewPane[] | null;
  /** The last completed run, or null before one ever finishes. `stale` is whether the case's
   * READY documents changed since it (the ready-set fingerprint differs). */
  generated: { panes: ClientOverviewPanes; stale: boolean } | null;
  /** The most recent job failed (or was lost). Only read while nothing has been generated —
   * after that, a failed run leaves the last good content in place. */
  lastRunFailed: boolean;
  /** The section has something to show. */
  hasContent: boolean;
}

/** One section's status, from already-resolved facts about the job, the stored run and the
 * section's content — no I/O, so every rule is covered by test/client-overview-status.spec.ts.
 * The first rule that matches wins. A pane this run already finished shows its fresh content
 * mid-run: each pane writes its own table as it settles, before the job saves anything. */
export function sectionStatus(input: SectionStatusInput): SectionStatus {
  if (input.runningPanesDone) {
    if (!input.runningPanesDone.includes(input.pane)) return "RUNNING";
    return input.hasContent ? "READY" : "EMPTY";
  }
  if (!input.generated) return input.lastRunFailed ? "FAILED" : "EMPTY";
  if (input.generated.panes[input.pane] === "FAILED") return "FAILED";
  if (input.generated.stale) return "STALE";
  return input.hasContent ? "READY" : "EMPTY";
}
