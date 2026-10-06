export const PANEL_IDS = [
  "command",
  "evidence",
  "law",
  "dates",
  "chat",
  "mindMap",
  "redTeam",
  "procedure",
  "legalIssues",
  "weaknesses",
  "strengths",
  "attackStrategy",
  "defenseStrategy",
  "witnesses",
  "damages",
  "caseReconstruction",
  "audioOverview",
  "decisions",
  "theories",
  "trace",
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

/** Panes that belong together sit next to each other in Columns/Tabs. Mirrors apps/web/lib/terminal/types.ts's PANEL_GROUP —
 * keep both in sync. Array order = group order on the board. Panes absent here (dates) are hidden and never placed. */
export const PANEL_GROUPS: readonly (readonly PanelId[])[] = [
  ["command", "evidence", "procedure", "witnesses", "damages"],
  ["law", "legalIssues", "decisions"],
  ["strengths", "weaknesses", "attackStrategy", "defenseStrategy", "redTeam", "theories"],
  ["chat", "mindMap", "caseReconstruction", "audioOverview", "trace"],
];

/** Sort key for grouping: group index, then position inside the group. Unlisted panes sort last. */
export const panelGroupRank = (id: PanelId): number => {
  const g = PANEL_GROUPS.findIndex((ids) => ids.includes(id));
  return g === -1 ? 1000 : g * 100 + PANEL_GROUPS[g]!.indexOf(id);
};

/** Saved layouts below this get their Columns/Tabs panes regrouped once (see regroupLayoutOnce). */
export const LAYOUT_VERSION = 1;

export const PRESET_VALUES =["PANE_1", "PANE_2", "PANE_4", "PANE_6"] as const;
export type PresetValue = (typeof PRESET_VALUES)[number];

// "split" was a legacy value never actually referenced anywhere else in this codebase — replaced
// with "free" to match the app's real arrangement values (apps/web/lib/terminal/types.ts). This
// list gates normalizeLayout's isArrangementValue check, so before this fix any workspace saved
// with "free" (every multi-screen Free-canvas layout) was silently coerced to "columns" on every
// save — the arrangement mode itself never survived a reload.
export const ARRANGEMENT_VALUES = ["free", "columns", "tabs", "focus"] as const;
export type ArrangementValue = (typeof ARRANGEMENT_VALUES)[number];

export interface PanelLayout {
  id: PanelId;
  visible: boolean;
  order: number;
  width: number;
  height: number;
  /** Left edge as a 0–1 fraction of the workspace. Independent of other panes. */
  x?: number;
  /** Top edge as a 0–1 fraction of the workspace. Independent of other panes. */
  y?: number;
  /** Columns mode only: which column (0-based) this pane is stacked in. */
  columnIndex?: number;
  /** Tabs mode only: which of the 2 groups this pane's tab lives in. */
  tabGroup?: number;
  /** Protects this pane's own slot from move/resize/reassignment. */
  pinned?: boolean;
  /** Which physical screen this pane renders on. 0 or absent = primary; 1-5 = a secondary canvas
   * window, numbered left-to-right and recomputed fresh each session — mirrors
   * apps/web/lib/terminal/types.ts's PanelLayout.screen exactly. */
  screen?: number;
}

export interface WorkspaceLayout {
  preset: PresetValue;
  /** Optional — absent on workspaces saved before arrangement modes existed, treated as "columns". */
  arrangement?: ArrangementValue;
  panels: PanelLayout[];
  /** Absent on layouts saved before pane grouping; see LAYOUT_VERSION. */
  layoutVersion?: number;
  /** Columns mode: how many columns and their widths as fractions summing to 1. */
  columnCount?: number;
  columnWidths?: number[];
  /** Tabs mode: the 2 groups' width split and each group's active tab. */
  tabsSplit?: number;
  tabsActiveA?: PanelId;
  tabsActiveB?: PanelId;
  /** Per-secondary-screen arrangement state, keyed by screen index (1-5) — mirrors
   * apps/web/lib/terminal/types.ts's WorkspaceLayout.screenLayouts exactly. The top-level
   * arrangement/columnCount/columnWidths/tabsSplit/tabsActiveA/B fields above are screen 0's own. */
  screenLayouts?: Record<
    number,
    {
      arrangement?: ArrangementValue;
      columnCount?: number;
      columnWidths?: number[];
      tabsSplit?: number;
      tabsActiveA?: PanelId;
      tabsActiveB?: PanelId;
    }
  >;
}

export interface PanelCatalogEntry {
  id: PanelId;
  label: string;
  phase: "P1" | "P2" | "P3" | "P5";
  defaultHidden: boolean;
  minSku: "SOLO" | "PROFESSIONAL" | "ENTERPRISE";
  description: string;
}

export const PANEL_CATALOG: PanelCatalogEntry[] = [
  {
    id: "command",
    label: "Case Command",
    phase: "P1",
    defaultHidden: false,
    minSku: "SOLO",
    description: "Case header, next date, risk checklist, next actions, confirm status",
  },
  {
    id: "evidence",
    label: "Evidence & Timeline",
    phase: "P1",
    defaultHidden: false,
    minSku: "SOLO",
    description: "Documents, source links, case timeline",
  },
  {
    id: "law",
    label: "Law & Precedent",
    phase: "P1",
    defaultHidden: false,
    minSku: "SOLO",
    description: "Statutes, precedents, citations",
  },
  {
    id: "dates",
    label: "Timeline",
    phase: "P1",
    defaultHidden: true,
    minSku: "SOLO",
    description: "Folded into Evidence & Timeline — not shown as its own pane",
  },
  {
    id: "chat",
    label: "Chat",
    phase: "P1",
    defaultHidden: false,
    minSku: "SOLO",
    description: "Consultation chat, demoted from the home screen",
  },
  {
    id: "mindMap",
    label: "Visual Strategy Map",
    phase: "P1",
    defaultHidden: false,
    minSku: "SOLO",
    description: "Case strategy mind map generated from the consultation",
  },
  {
    id: "redTeam",
    label: "Red Team",
    phase: "P3",
    defaultHidden: true,
    minSku: "SOLO",
    description: "Adversarial threat assessment — opposing counsel's likely attacks on this case, generated on demand",
  },
  {
    id: "procedure",
    label: "Procedure & Filing",
    phase: "P3",
    defaultHidden: false,
    minSku: "SOLO",
    description: "Deadlines and filing checklist",
  },
  {
    id: "legalIssues",
    label: "Legal Issues",
    phase: "P3",
    defaultHidden: true,
    minSku: "SOLO",
    description: "The legal questions/causes of action raised by the case — manually entered or AI-generated from documents",
  },
  {
    id: "weaknesses",
    label: "Weaknesses",
    phase: "P3",
    defaultHidden: true,
    minSku: "SOLO",
    description: "Points that hurt this case's persuasive strength — manually entered or AI-generated from documents",
  },
  {
    id: "strengths",
    label: "Strengths",
    phase: "P3",
    defaultHidden: true,
    minSku: "SOLO",
    description: "Points that help this case's persuasive strength — manually entered or AI-generated from documents",
  },
  {
    id: "attackStrategy",
    label: "Attack Strategies",
    phase: "P3",
    defaultHidden: true,
    minSku: "SOLO",
    description: "Affirmative moves to advance this case — manually entered or AI-generated from documents",
  },
  {
    id: "defenseStrategy",
    label: "Defense Strategies",
    phase: "P3",
    defaultHidden: true,
    minSku: "SOLO",
    description: "Moves to protect this case's position — manually entered or AI-generated from documents",
  },
  {
    id: "witnesses",
    label: "Witnesses",
    phase: "P3",
    defaultHidden: true,
    minSku: "SOLO",
    description: "Witness roster: name, role, contact, notes",
  },
  {
    id: "damages",
    label: "Damages & Remedies",
    phase: "P3",
    defaultHidden: true,
    minSku: "SOLO",
    description: "Money claimed and other orders sought, each with the document line it comes from, the total, and what is awarded so far",
  },
  {
    id: "caseReconstruction",
    label: "Case Reconstruction",
    phase: "P3",
    defaultHidden: true,
    minSku: "SOLO",
    description: "AI-generated chronological narrative of the case, editable afterward",
  },
  {
    id: "audioOverview",
    label: "Audio Overview",
    phase: "P3",
    defaultHidden: true,
    minSku: "SOLO",
    description: "Two-host podcast-style discussion of the case, generated on demand and rendered to speech",
  },
  {
    id: "decisions",
    label: "Decisions",
    phase: "P3",
    defaultHidden: true,
    minSku: "SOLO",
    description: "The 'Why?' behind a legal answer's conclusions — rule, evidence for and against, the alternative considered and rejected, and what fact would change it. Populated automatically from legal chat turns, not generated on demand.",
  },
  {
    id: "theories",
    label: "Theories",
    phase: "P3",
    defaultHidden: true,
    minSku: "SOLO",
    description: "Several lawyers' theories of the case, side by side — never merged. Diff any two to see what they share, what they disagree on, and the evidence that would decide it.",
  },
  {
    id: "trace",
    label: "AI Reasoning",
    phase: "P3",
    defaultHidden: true,
    minSku: "SOLO",
    description: "How the AI reached each answer, turn by turn — the research it ran, what it found, and the checks it applied. Recorded as the answer is written, and kept with the consultation.",
  },
];

const SKU_RANK: Record<string, number> = { SOLO: 0, PROFESSIONAL: 1, ENTERPRISE: 2 };

export function skuAllowsPanel(sku: string, minSku: string): boolean {
  return (SKU_RANK[sku] ?? 0) >= (SKU_RANK[minSku] ?? 0);
}

export function defaultPresetForSku(sku: string): PresetValue {
  if (sku === "ENTERPRISE") return "PANE_6";
  if (sku === "PROFESSIONAL") return "PANE_4";
  return "PANE_2";
}

export function defaultPanelIdsForPreset(preset: PresetValue): PanelId[] {
  switch (preset) {
    case "PANE_1":
      return ["command"];
    case "PANE_2":
      return ["command", "evidence"];
    case "PANE_4":
      return ["command", "evidence", "law", "chat"];
    case "PANE_6":
      return ["command", "evidence", "law", "mindMap", "procedure", "chat"];
    default:
      return ["command", "evidence"];
  }
}
