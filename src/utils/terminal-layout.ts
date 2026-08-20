import {
  defaultPanelIdsForPreset,
  PANEL_CATALOG,
  PANEL_IDS,
  PanelId,
  PanelLayout,
  PresetValue,
  skuAllowsPanel,
  WorkspaceLayout,
} from "../constants/terminal.constants";

function isPanelId(value: unknown): value is PanelId {
  return typeof value === "string" && (PANEL_IDS as readonly string[]).includes(value);
}

export function buildDefaultLayout(preset: PresetValue, sku = "SOLO"): WorkspaceLayout {
  const visibleIds = defaultPanelIdsForPreset(preset).filter((id) => {
    const entry = PANEL_CATALOG.find((p) => p.id === id);
    if (!entry) return false;
    if (entry.defaultHidden) return false;
    return skuAllowsPanel(sku, entry.minSku);
  });

  const count = Math.max(visibleIds.length, 1);
  const panels: PanelLayout[] = PANEL_CATALOG.filter((entry) => skuAllowsPanel(sku, entry.minSku)).map(
    (entry, index) => {
      const visibleIndex = visibleIds.indexOf(entry.id);
      const visible = visibleIndex !== -1;
      return {
        id: entry.id,
        visible,
        order: visible ? visibleIndex : 100 + index,
        width: visible ? 1 / count : 0,
        height: 1,
      };
    },
  );

  return { preset, panels };
}

export function normalizeLayout(input: unknown, sku = "SOLO"): WorkspaceLayout {
  const raw = (input ?? {}) as Partial<WorkspaceLayout> & { preset?: string; panels?: unknown[] };
  const preset: PresetValue =
    raw.preset === "PANE_1" || raw.preset === "PANE_2" || raw.preset === "PANE_4" || raw.preset === "PANE_6"
      ? raw.preset
      : "PANE_2";

  const fallback = buildDefaultLayout(preset, sku);
  if (!Array.isArray(raw.panels) || raw.panels.length === 0) return fallback;

  const seen = new Set<PanelId>();
  const panels: PanelLayout[] = [];

  for (const item of raw.panels) {
    const row = item as Partial<PanelLayout>;
    if (!isPanelId(row.id) || seen.has(row.id)) continue;
    const entry = PANEL_CATALOG.find((p) => p.id === row.id);
    if (!entry || !skuAllowsPanel(sku, entry.minSku)) continue;
    seen.add(row.id);
    const visible = row.id === "redTeam" || row.id === "dates" ? false : Boolean(row.visible);
    panels.push({
      id: row.id,
      visible,
      order: Number.isFinite(row.order) ? Number(row.order) : panels.length,
      width: clampRatio(row.width),
      height: clampRatio(row.height),
    });
  }

  for (const entry of PANEL_CATALOG) {
    if (seen.has(entry.id) || !skuAllowsPanel(sku, entry.minSku)) continue;
    panels.push({
      id: entry.id,
      visible: false,
      order: 100 + panels.length,
      width: 0,
      height: 1,
    });
  }

  if (!panels.some((p) => p.visible)) {
    const command = panels.find((p) => p.id === "command");
    if (command) {
      command.visible = true;
      command.width = 1;
      command.height = 1;
      command.order = 0;
    }
  }

  return { preset, panels };
}

function clampRatio(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}
