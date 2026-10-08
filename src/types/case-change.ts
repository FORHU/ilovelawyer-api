import { ConfidenceLevel, FindingCategory, FindingTag, OutlookBand } from "@prisma/client";
import { RedTeamArgumentStrength } from "../utils/red-team-arguments-parse";
import { ReconstructionClaimCategory } from "../utils/case-reconstruction-claims-parse";

/** What one analysis refresh did to a pane, compared with what the pane said before it.
 * "skipped": the step didn't rewrite the pane (its own job held the lock, nothing to work from,
 * or a lawyer's edit is protected). "failed": the step threw; the pane keeps its old content.
 * Stored on CaseChangeSummary.perPaneDeltas and mirrored in ilovelawyer-app's
 * lib/terminal/change-summary.ts — change both together. */
export type PaneStatus = "changed" | "unchanged" | "skipped" | "failed";

/** One contradiction as the modal names it. Values and document names are copied in, so the
 * summary still reads after a later scan has replaced the rows it describes. */
export interface ContradictionRef {
  kind: string;
  factKey: string;
  leftValue: string;
  rightValue: string;
  leftDocument: string | null;
  rightDocument: string | null;
}

export interface ContradictionsDelta {
  status: PaneStatus;
  added: ContradictionRef[];
  addedCount: number;
  dropped: ContradictionRef[];
  droppedCount: number;
  carriedOver: number;
  /** Of the dropped ones, how many a lawyer had already triaged (status other than OPEN) — that
   * triage goes with the row. */
  droppedTriaged: number;
}

export interface FindingRating {
  tag: FindingTag | null;
  impact: number | null;
}

export interface FindingCategoryDelta {
  added: string[];
  removed: string[];
  rerated: { label: string; from: FindingRating; to: FindingRating }[];
}

export interface FindingsDelta {
  status: PaneStatus;
  byCategory: Partial<Record<FindingCategory, FindingCategoryDelta>>;
  /** Set when the run rewrote one category only (that panel's own Regenerate) — the modal names
   * that panel even when nothing in it changed. */
  category?: FindingCategory;
}

export interface RedTeamDelta {
  status: PaneStatus;
  /** No assessment before this run — nothing to compare, so nothing counts. */
  first: boolean;
  riskOfLoss: { from: number | null; to: number | null };
  added: string[];
  dropped: string[];
  restrengthened: { title: string; from: RedTeamArgumentStrength; to: RedTeamArgumentStrength }[];
}

export type AttributionCounts = Record<ReconstructionClaimCategory, number>;

export interface ReconstructionDelta {
  status: PaneStatus;
  outcome: "generated" | "regenerated" | "skipped-edited" | null;
  gapsOpened: string[];
  gapsClosed: string[];
  attribution: { from: AttributionCounts | null; to: AttributionCounts | null };
}

export interface OutlookDriverRef {
  label: string;
  direction: "HELPS" | "HURTS";
}

export interface OutlookDelta {
  status: PaneStatus;
  first: boolean;
  band: { from: OutlookBand | null; to: OutlookBand | null };
  confidence: { from: ConfidenceLevel | null; to: ConfidenceLevel | null };
  driversAdded: OutlookDriverRef[];
  driversDropped: OutlookDriverRef[];
}

/** Case Strategy's plan and to-dos (ProcedureItem STRATEGY/TODO) and the key dates the same step
 * writes onto the timeline (Evidence & Timeline). */
export interface StrategyDelta {
  status: PaneStatus;
  planAdded: string[];
  planRemoved: string[];
  todosAdded: string[];
  todosRemoved: string[];
  datesAdded: { title: string; occurredOn: string | null }[];
  datesRemoved: { title: string; occurredOn: string | null }[];
}

export interface WitnessesDelta {
  status: PaneStatus;
  added: string[];
  removed: string[];
  /** The credibility score the pane shows (a lawyer's override, else the AI's, else the default),
   * when it moved by CASE_CHANGE_CREDIBILITY_THRESHOLD or more. */
  rescored: { name: string; from: number; to: number }[];
}

export interface DamagesDelta {
  status: PaneStatus;
  added: string[];
  removed: string[];
  amountChanged: { title: string; from: number | null; to: number | null }[];
}

/** The case's one AI draft theory (CaseTheorySvc), rewritten in place. */
export interface TheoryDelta {
  status: PaneStatus;
  /** No AI draft before this run — nothing to compare, so nothing counts. */
  first: boolean;
  title: { from: string | null; to: string | null };
  claimsAdded: string[];
  claimsDropped: string[];
  assumptionsChanged: number;
  openQuestionsChanged: number;
}

/** The document-built case map. Branches are the root's children; points are every node below. */
export interface MindMapDelta {
  status: PaneStatus;
  /** No map before this run: `branchesAdded` lists every branch it built, and nothing counts. */
  first: boolean;
  branchesAdded: string[];
  branchesRemoved: string[];
  pointsAdded: number;
  pointsRemoved: number;
  /** The map wasn't rebuilt because someone had expanded or edited it. */
  keptUserChanges: boolean;
}

/** A new Audio Overview was written (it shows in the pane's History). Never counted as a change in
 * the analysis — a fresh script is written every run. */
export interface AudioOverviewDelta {
  status: PaneStatus;
  overviewId: string | null;
}

/** A pane whose step didn't get as far as a before/after comparison: it threw ("failed"), its own
 * job held the lock, or it had nothing to work from ("skipped"). */
export interface PaneNotRun {
  status: "skipped" | "failed";
}

/** A pane missing from this object wasn't tracked by that run (e.g. a summary written before the
 * pane was added). */
export interface CaseChangeDeltas {
  contradictions?: ContradictionsDelta | PaneNotRun;
  findings?: FindingsDelta | PaneNotRun;
  redTeam?: RedTeamDelta | PaneNotRun;
  reconstruction?: ReconstructionDelta | PaneNotRun;
  outlook?: OutlookDelta | PaneNotRun;
  strategy?: StrategyDelta | PaneNotRun;
  witnesses?: WitnessesDelta | PaneNotRun;
  damages?: DamagesDelta | PaneNotRun;
  theory?: TheoryDelta | PaneNotRun;
  mindMap?: MindMapDelta | PaneNotRun;
  audioOverview?: AudioOverviewDelta | PaneNotRun;
}

export type CaseChangePane = keyof CaseChangeDeltas;

/** What ran: a lawyer's "Refresh analysis", the automatic refresh after a document change, or one
 * pane's own Regenerate (a summary of that pane alone). */
export type CaseChangeReason = "manual" | "post-extraction" | "regenerate";

export interface ChangedDocument {
  id: string;
  /** Null for a removed document that has since been deleted outright. */
  name: string | null;
}
