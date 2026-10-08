/** The Terminal panes a lawyer edits by hand — the app's PanelId values, so the "What changed"
 * modal's Open link goes straight to the pane. Mirrored in ilovelawyer-app's
 * lib/terminal/manual-edits.ts; change both together. */
export type ManualEditPane =
  | "command"
  | "evidence"
  | "procedure"
  | "witnesses"
  | "damages"
  | "legalIssues"
  | "strengths"
  | "weaknesses"
  | "attackStrategy"
  | "defenseStrategy"
  | "law"
  | "decisions"
  | "theories"
  | "caseReconstruction"
  | "mindMap";

export type ManualEditKind =
  | "risk"
  | "finding"
  | "contradiction"
  | "timelineEntry"
  | "evidenceRating"
  | "custodyEvent"
  | "missingEvidence"
  | "todo"
  | "deadline"
  | "witness"
  | "damage"
  | "authority"
  | "citation"
  | "citationGround"
  | "decision"
  | "theory"
  | "theoryClaim"
  | "theoryAssumption"
  | "theoryQuestion"
  | "narrative"
  | "mapPoint";

export type ManualEditAction =
  | "added"
  | "edited"
  | "removed"
  | "resolved"
  | "dismissed"
  | "reopened"
  | "ticked"
  | "unticked"
  | "accepted"
  | "awarded"
  | "disputed"
  | "reactivated"
  | "published"
  | "retired"
  | "forked"
  | "confirmed"
  | "unconfirmed"
  | "recomputed"
  | "expanded"
  | "reverted";

export type ManualEditValue = string | number | boolean | null;

/** One field an edit changed. Short values (tags, statuses, amounts, dates) keep from/to; long
 * text (a detail, a note, a narrative) only names the field. */
export interface ManualEditChange {
  field: string;
  from?: ManualEditValue;
  to?: ManualEditValue;
}

export interface ManualEditEntry {
  pane: ManualEditPane;
  kind: ManualEditKind;
  itemId?: string | null;
  action: ManualEditAction;
  label: string;
  changes?: ManualEditChange[];
}
