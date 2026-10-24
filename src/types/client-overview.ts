/** The client app's Overview tab: GET /api/client/cases/:caseId/overview (ilovelawyer-api#571,
 * C1), also returned by POST .../overview/generate (#572, C2). Mirrored in swagger-client-app.ts
 * and in ilovelawyer-client's src/lib/types.ts — change all three together.
 * test/client-case-overview.spec.ts lists every field and fails on any addition or removal.
 *
 * Deliberately excludes everything the lawyer's Terminal shows and a client never sees: case
 * outlook, win likelihood, strategy/to-dos, legal issues, attack/defense strategy. */

export type OverviewPane = "strategy" | "findings" | "missingEvidence";

/** Each section's own status. RUNNING while the live job hasn't finished that section's pane;
 * STALE once the case's READY documents changed since generatedAt (all job-written sections go
 * STALE together — one job rewrites them together). keyDates is never written by the job, so it
 * is only READY or EMPTY. See sectionStatus (utils/client-overview-status.ts). */
export type SectionStatus = "EMPTY" | "RUNNING" | "READY" | "FAILED" | "STALE";

export interface OverviewTimelineEntry {
  id: string;
  /** ISO 8601 date-time. Null for an entry with no date at all (rare; sorts last). */
  date: string | null;
  label: string;
  /** Both null when the entry has no source document, or that document is no longer on the case. */
  sourceDocumentId: string | null;
  sourceDocumentName: string | null;
}

/** A procedural deadline (ProceduralDeadline). CONFIRMED once anyone has confirmed it. */
export interface OverviewKeyDate {
  id: string;
  label: string;
  /** ISO 8601 date-time: the computed due date. */
  date: string;
  status: "CONFIRMED" | "ESTIMATED";
}

/** An open missing-evidence item. */
export interface OverviewGatherItem {
  id: string;
  title: string;
  why: string;
}

/** A point that helps (CaseFinding STRENGTH) or may hurt (WEAKNESS) the case. */
export interface OverviewPoint {
  id: string;
  title: string;
  detail: string | null;
}

export interface CaseOverview {
  generatedAt: string | null;
  /** The live job, or null when nothing is running. */
  job: { startedAt: string; panesDone: OverviewPane[] } | null;
  /** READY documents added or removed since generatedAt. Null when nothing changed, or nothing
   * has been generated yet. */
  changedSince: { added: number; removed: number } | null;
  /** Whether Generate/Update can be pressed now, and how many presses are left today (D1). */
  updates: { allowed: boolean; leftToday: number };

  sections: {
    summary: SectionStatus;
    timeline: SectionStatus;
    /** Absent for a case outside the UK (D5), with keyDates. */
    keyDates?: SectionStatus;
    toGather: SectionStatus;
    helps: SectionStatus;
    mayHurt: SectionStatus;
  };

  summary: string | null;
  timeline: OverviewTimelineEntry[];
  keyDates?: OverviewKeyDate[];
  toGather: OverviewGatherItem[];
  helps: OverviewPoint[];
  mayHurt: OverviewPoint[];
}
