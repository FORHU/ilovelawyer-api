import {
  ARRANGEMENT_VALUES,
  ArrangementValue,
  defaultPanelIdsForPreset,
  LAYOUT_VERSION,
  PANEL_CATALOG,
  PANEL_IDS,
  panelGroupRank,
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
 * Deliberately narrower than normalizeLayout: it only drops unknown ids and shows the Command pane if nothing visible is
 * left. It does not re-clamp sizes, re-apply SKU gating or add missing panes, so reading a workspace never changes anything
 * else about it. Returns the same object when there is nothing to drop, and anything that is not a layout untouched. */
export function dropUnknownPanelsFromLayout(layoutJson: unknown): unknown {
  if (!isRecord(layoutJson) || !Array.isArray(layoutJson.panels)) return layoutJson;

  const panels = layoutJson.panels.filter((p) => isRecord(p) && isPanelId(p.id));
  if (panels.length === layoutJson.panels.length) return layoutJson;

  let kept = panels as Record<string, unknown>[];
  if (!kept.some((p) => p.visible === true)) {
    kept = kept.map((p) => (p.id === "command" ? { ...p, visible: true, order: 0, width: 1, height: 1 } : p));
  }
  return { ...layoutJson, panels: kept };
}

const TAB_FIELDS = ["tabsSplit", "tabsActiveA", "tabsActiveB"];

/** The Tabs arrangement was removed. A layout saved with it becomes 2 Columns (tabGroup 0/1 -> columnIndex 0/1, tabsSplit ->
 * columnWidths) and the Tabs-only fields are dropped. Idempotent: returns the same object once nothing Tabs-related is left.
 * Runs on read and on save, so an old client's save is converted too. Anything that is not a layout comes back untouched. */
export function tabsToColumns(layoutJson: unknown): unknown {
  if (!isRecord(layoutJson) || !Array.isArray(layoutJson.panels)) return layoutJson;
  const screens = isRecord(layoutJson.screenLayouts) ? layoutJson.screenLayouts : {};
  const dirty = (c: unknown) => isRecord(c) && (c.arrangement === "tabs" || TAB_FIELDS.some((k) => k in c));
  const rows = layoutJson.panels as Record<string, unknown>[];
  if (!dirty(layoutJson) && !Object.values(screens).some(dirty) && !rows.some((p) => isRecord(p) && "tabGroup" in p)) return layoutJson;

  const convert = (cfg: Record<string, unknown>) => {
    const split = typeof cfg.tabsSplit === "number" ? clampRatio(cfg.tabsSplit) : 0.5;
    const out = { ...cfg };
    for (const k of TAB_FIELDS) delete out[k];
    return cfg.arrangement === "tabs" ? { ...out, arrangement: "columns", columnCount: 2, columnWidths: [split, 1 - split] } : out;
  };

  const tabScreens = new Set<number>();
  if (layoutJson.arrangement === "tabs") tabScreens.add(0);
  for (const [i, s] of Object.entries(screens)) if (isRecord(s) && s.arrangement === "tabs") tabScreens.add(Number(i));

  // A pane without a tabGroup auto-joined the group with fewer tabs; keep that.
  const sizes = new Map<number, [number, number]>();
  const screenOf = (p: Record<string, unknown>) => (typeof p.screen === "number" ? p.screen : 0);
  const placed = rows.map((p) => {
    if (!isRecord(p)) return p;
    const { tabGroup, ...rest } = p;
    if (!tabScreens.has(screenOf(p)) || p.visible !== true) return rest;
    const n = sizes.get(screenOf(p)) ?? [0, 0];
    sizes.set(screenOf(p), n);
    const col = tabGroup === 0 || tabGroup === 1 ? tabGroup : n[0] <= n[1] ? 0 : 1;
    n[col]++;
    return { ...rest, columnIndex: col };
  });
  const panels = placed.map((p) => {
    const n = isRecord(p) ? sizes.get(screenOf(p)) : undefined;
    return n && typeof p.columnIndex === "number" ? { ...p, height: 1 / n[p.columnIndex as 0 | 1] } : p;
  });

  const out: Record<string, unknown> = { ...convert(layoutJson), panels };
  if (isRecord(layoutJson.screenLayouts)) {
    out.screenLayouts = Object.fromEntries(Object.entries(screens).map(([i, s]) => [i, isRecord(s) ? convert(s) : s]));
  }
  return out;
}

/** One-time regroup of a saved layout so related panes (PANEL_GROUPS) sit together. Runs when `layoutVersion` is below
 * LAYOUT_VERSION, then stamps it, so a later manual drag is never undone. Columns only: Free x/y and Focus are
 * deliberate placements, and pinned panes keep their slot. Anything that is not a layout comes back untouched. */
export function regroupLayoutOnce(layoutJson: unknown): unknown {
  if (!isRecord(layoutJson) || !Array.isArray(layoutJson.panels)) return layoutJson;
  if (typeof layoutJson.layoutVersion === "number" && layoutJson.layoutVersion >= LAYOUT_VERSION) return layoutJson;

  const screens = isRecord(layoutJson.screenLayouts) ? layoutJson.screenLayouts : {};
  let panels = layoutJson.panels as Record<string, unknown>[];
  const screenIndexes = new Set<number>([0, ...panels.map((p) => (typeof p.screen === "number" ? p.screen : 0))]);

  for (const screen of screenIndexes) {
    const cfg = (screen === 0 ? layoutJson : screens[screen]) as Record<string, unknown> | undefined;
    if (!isRecord(cfg)) continue;
    const arrangement = cfg.arrangement ?? "columns";
    if (arrangement !== "columns") continue;
    const slots = Math.min(8, Math.max(1, Math.round(Number(cfg.columnCount) || 3)));

    const movable = panels
      .filter((p) => isRecord(p) && isPanelId(p.id) && p.visible === true && p.pinned !== true && p.id !== "dates" && ((p.screen as number) || 0) === screen)
      .sort((a, b) => panelGroupRank(a.id as PanelId) - panelGroupRank(b.id as PanelId));
    if (movable.length === 0) continue;

    // Fill slots in group order: a whole group moves to the next slot rather than split, unless it is bigger than a slot.
    const capacity = Math.ceil(movable.length / slots);
    const groupSize = (id: unknown) => movable.filter((p) => Math.floor(panelGroupRank(p.id as PanelId) / 100) === Math.floor(panelGroupRank(id as PanelId) / 100)).length;
    const slotIndex: number[] = [];
    let cursor = 0;
    let used = 0;
    movable.forEach((p, i) => {
      const startsGroup = i === 0 || Math.floor(panelGroupRank(p.id as PanelId) / 100) !== Math.floor(panelGroupRank(movable[i - 1]!.id as PanelId) / 100);
      if (cursor < slots - 1 && used > 0 && ((startsGroup && used + groupSize(p.id) > capacity) || used >= capacity)) {
        cursor++;
        used = 0;
      }
      slotIndex[i] = cursor;
      used++;
    });
    const slotOf = (i: number) => slotIndex[i]!;
    const sizes = new Map<number, number>();
    movable.forEach((_, i) => sizes.set(slotOf(i), (sizes.get(slotOf(i)) ?? 0) + 1));
    const patch = new Map<unknown, Record<string, unknown>>();
    movable.forEach((p, i) => {
      const slot = slotOf(i);
      patch.set(p, { columnIndex: slot, order: i, height: 1 / sizes.get(slot)! });
    });
    panels = panels.map((p) => (patch.has(p) ? { ...p, ...patch.get(p) } : p));
  }

  return { ...layoutJson, panels, layoutVersion: LAYOUT_VERSION };
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

  return { preset, arrangement: "columns", panels, layoutVersion: LAYOUT_VERSION };
}

export function normalizeLayout(input: unknown, sku = "SOLO"): WorkspaceLayout {
  const raw = tabsToColumns(input ?? {}) as Partial<WorkspaceLayout> & { preset?: string; panels?: unknown[] };
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

  // The arrangement-mode fields below are what make a Columns layout survive a reload —
  // dropping them turned every saved Columns layout into a legacy Free one on the client
  // (it treats a missing columnCount as "pre-rework save") and snapped panes back to old x/y.
  const columnWidths = Array.isArray(raw.columnWidths)
    ? raw.columnWidths.slice(0, MAX_COLUMNS).map((w) => clampRatio(w))
    : undefined;

  return {
    preset,
    arrangement,
    panels,
    // Kept as sent: an old client save must not skip the one-time regroup by being stamped current here.
    layoutVersion: typeof raw.layoutVersion === "number" ? raw.layoutVersion : undefined,
    columnCount: clampInt(raw.columnCount, 1, MAX_COLUMNS),
    columnWidths,
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
