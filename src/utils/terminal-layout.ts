import {
  ARRANGEMENT_VALUES,
  ArrangementValue,
  defaultPanelIdsForPreset,
  PANEL_CATALOG,
  PANEL_IDS,
  PanelId,
  PanelLayout,
  PresetValue,
  skuAllowsPanel,
  WorkspaceLayout,
} from "../constants";

export function isPanelId(value: unknown): value is PanelId {
  return typeof value === "string" && (PANEL_IDS as readonly string[]).includes(value);
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** A stored layout, minus any pane the Terminal no longer has (ADR 0016 retired Contradictions, Citation Map, Team & Audit and
 * Verification). normalizeLayout does this when a workspace is SAVED, but a workspace saved before then is returned as
 * stored, and the web app crashes rendering a retired pane that is visible. Applied to every layout this service hands out.
 *
 * Deliberately narrower than normalizeLayout: it only drops unknown ids, clears a tab that pointed at one, and shows the
 * Command pane if nothing visible is left. It does not re-clamp sizes, re-apply SKU gating or add missing panes, so reading a
 * workspace never changes anything else about it. Returns the same object when there is nothing to drop, and anything that is
 * not a layout untouched. */
export function dropUnknownPanelsFromLayout(layoutJson: unknown): unknown {
  if (!isRecord(layoutJson) || !Array.isArray(layoutJson.panels)) return layoutJson;

  const panels = layoutJson.panels.filter((p) => isRecord(p) && isPanelId(p.id));
  const badTab = (value: unknown) => value !== undefined && value !== null && !isPanelId(value);
  const screens = isRecord(layoutJson.screenLayouts) ? layoutJson.screenLayouts : undefined;
  const screenTabsBad = !!screens && Object.values(screens).some((s) => isRecord(s) && (badTab(s.tabsActiveA) || badTab(s.tabsActiveB)));
  const dropped = panels.length < layoutJson.panels.length;
  if (!dropped && !badTab(layoutJson.tabsActiveA) && !badTab(layoutJson.tabsActiveB) && !screenTabsBad) return layoutJson;

  const withoutBadTabs = <T extends Record<string, unknown>>(obj: T): T => {
    const copy = { ...obj };
    if (badTab(copy.tabsActiveA)) delete copy.tabsActiveA;
    if (badTab(copy.tabsActiveB)) delete copy.tabsActiveB;
    return copy;
  };

  let kept = panels as Record<string, unknown>[];
  if (dropped && !kept.some((p) => p.visible === true)) {
    kept = kept.map((p) => (p.id === "command" ? { ...p, visible: true, order: 0, width: 1, height: 1 } : p));
  }

  const out: Record<string, unknown> = { ...withoutBadTabs(layoutJson), panels: kept };
  if (screens) {
    out.screenLayouts = Object.fromEntries(Object.entries(screens).map(([index, s]) => [index, isRecord(s) ? withoutBadTabs(s) : s]));
  }
  return out;
}

export function isArrangementValue(value: unknown): value is ArrangementValue {
  return typeof value === "string" && (ARRANGEMENT_VALUES as readonly string[]).includes(value);
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

  return { preset, arrangement: "columns", panels };
}

export function normalizeLayout(input: unknown, sku = "SOLO"): WorkspaceLayout {
  const raw = (input ?? {}) as Partial<WorkspaceLayout> & { preset?: string; panels?: unknown[] };
  const preset: PresetValue =
    raw.preset === "PANE_1" || raw.preset === "PANE_2" || raw.preset === "PANE_4" || raw.preset === "PANE_6"
      ? raw.preset
      : "PANE_2";
  const arrangement: ArrangementValue = isArrangementValue(raw.arrangement) ? raw.arrangement : "columns";

  const fallback = buildDefaultLayout(preset, sku);
  if (!Array.isArray(raw.panels) || raw.panels.length === 0) return { ...fallback, arrangement };

  const seen = new Set<PanelId>();
  const panels: PanelLayout[] = [];

  for (const item of raw.panels) {
    const row = item as Partial<PanelLayout>;
    if (!isPanelId(row.id) || seen.has(row.id)) continue;
    const entry = PANEL_CATALOG.find((p) => p.id === row.id);
    if (!entry || !skuAllowsPanel(sku, entry.minSku)) continue;
    seen.add(row.id);
    // "dates" is permanently folded into Evidence & Timeline (TerminalPanelBody renders it as
    // null) — redTeam is a real, addable panel now, not force-hidden the way it used to be.
    const visible = row.id === "dates" ? false : Boolean(row.visible);
    panels.push({
      id: row.id,
      visible,
      order: Number.isFinite(row.order) ? Number(row.order) : panels.length,
      width: clampRatio(row.width),
      height: clampRatio(row.height),
      x: Number.isFinite(Number(row.x)) ? clampRatio(row.x) : undefined,
      y: Number.isFinite(Number(row.y)) ? clampRatio(row.y) : undefined,
      columnIndex: clampInt(row.columnIndex, 0, MAX_COLUMNS - 1),
      tabGroup: clampInt(row.tabGroup, 0, 1),
      pinned: row.pinned === true ? true : undefined,
      // 0 means "primary", same as absent — clampInt would instead clamp a 0 UP into [1,5], so
      // that case is treated as "omit" here rather than reusing clampInt directly.
      screen:
        typeof row.screen === "number" && Number.isFinite(row.screen) && row.screen >= 1
          ? clampInt(row.screen, 1, MAX_SECONDARY_SCREENS)
          : undefined,
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

  // The arrangement-mode fields below are what make a Columns/Tabs layout survive a reload —
  // dropping them turned every saved Columns layout into a legacy Free one on the client
  // (it treats a missing columnCount as "pre-rework save") and snapped panes back to old x/y.
  const columnWidths = Array.isArray(raw.columnWidths)
    ? raw.columnWidths.slice(0, MAX_COLUMNS).map((w) => clampRatio(w))
    : undefined;
  const tabsSplit = typeof raw.tabsSplit === "number" && Number.isFinite(raw.tabsSplit) ? clampRatio(raw.tabsSplit) : undefined;

  return {
    preset,
    arrangement,
    panels,
    columnCount: clampInt(raw.columnCount, 1, MAX_COLUMNS),
    columnWidths,
    tabsSplit,
    tabsActiveA: isPanelId(raw.tabsActiveA) ? raw.tabsActiveA : undefined,
    tabsActiveB: isPanelId(raw.tabsActiveB) ? raw.tabsActiveB : undefined,
    screenLayouts: normalizeScreenLayouts(raw.screenLayouts),
  };
}

const MAX_COLUMNS = 8;
const MAX_SECONDARY_SCREENS = 5;

type ScreenLayoutEntry = NonNullable<WorkspaceLayout["screenLayouts"]>[number];

/** Same per-screen arrangement fields as the top-level WorkspaceLayout, but one set per secondary
 * screen index (1-5) instead of one shared set — see WorkspaceLayout.screenLayouts's doc comment. */
function normalizeScreenLayouts(raw: unknown): WorkspaceLayout["screenLayouts"] {
  if (!raw || typeof raw !== "object") return undefined;
  const out: NonNullable<WorkspaceLayout["screenLayouts"]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const screenIndex = Number(key);
    if (!Number.isInteger(screenIndex) || screenIndex < 1 || screenIndex > MAX_SECONDARY_SCREENS) continue;
    if (!value || typeof value !== "object") continue;
    const entry = value as Partial<ScreenLayoutEntry>;
    out[screenIndex] = {
      arrangement: isArrangementValue(entry.arrangement) ? entry.arrangement : undefined,
      columnCount: clampInt(entry.columnCount, 1, MAX_COLUMNS),
      columnWidths: Array.isArray(entry.columnWidths)
        ? entry.columnWidths.slice(0, MAX_COLUMNS).map((w: unknown) => clampRatio(w))
        : undefined,
      tabsSplit: typeof entry.tabsSplit === "number" && Number.isFinite(entry.tabsSplit) ? clampRatio(entry.tabsSplit) : undefined,
      tabsActiveA: isPanelId(entry.tabsActiveA) ? entry.tabsActiveA : undefined,
      tabsActiveB: isPanelId(entry.tabsActiveB) ? entry.tabsActiveB : undefined,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Integer within [min, max], or undefined when absent/invalid so the key is omitted on save. */
function clampInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampRatio(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}
