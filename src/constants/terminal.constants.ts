export const PANEL_IDS = [
  "command",
  "evidence",
  "law",
  "dates",
  "chat",
  "mindMap",
  "redTeam",
  "procedure",
  "risk",
  "teamAudit",
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

export const PRESET_VALUES = ["PANE_1", "PANE_2", "PANE_4", "PANE_6"] as const;
export type PresetValue = (typeof PRESET_VALUES)[number];

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
}

export interface WorkspaceLayout {
  preset: PresetValue;
  panels: PanelLayout[];
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
    phase: "P1",
    defaultHidden: true,
    minSku: "SOLO",
    description: "Reserved until SCL lands — hidden by default",
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
    id: "risk",
    label: "Risk Analysis",
    phase: "P1",
    defaultHidden: false,
    minSku: "SOLO",
    description: "Overall and liability risk meters from case signals",
  },
  {
    id: "teamAudit",
    label: "Team & Audit",
    phase: "P5",
    defaultHidden: false,
    minSku: "PROFESSIONAL",
    description: "Assignments, approvals, audit trail",
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
      return ["command", "evidence", "law", "chat", "risk"];
    case "PANE_6":
      return ["command", "evidence", "law", "mindMap", "procedure", "chat", "risk"];
    default:
      return ["command", "evidence"];
  }
}
