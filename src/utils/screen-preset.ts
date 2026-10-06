import { ArrangementValue, PanelId, PANEL_CATALOG, skuAllowsPanel } from "../constants";
import { isArrangementValue, isPanelId } from "./terminal-layout";
import HttpError from "./http-error";

export interface ScreenPresetScreen {
  arrangement: ArrangementValue;
  panelIds: PanelId[];
  /** Columns screens only: which pane sits in which column (left to right, top to bottom). Overrides the default even
   * spread when applied; `panelIds` is always its flattened form. */
  columns?: PanelId[][];
}

// Validates a preset's `screens` against this user's own sku (same catalog/sku gate
// normalizeLayout uses) and computes screenCount from the result — throws rather than silently
// dropping bad input, since (unlike a workspace layout) a preset is a deliberate lawyer-authored
// template, not a save-as-you-go autosave that has to tolerate a stray bad field.
export function normalizeScreenPresetScreens(input: unknown, sku: string): { screens: ScreenPresetScreen[]; screenCount: number } {
  if (!Array.isArray(input) || input.length === 0) throw new HttpError("screens must be a non-empty array", 400);

  const screens: ScreenPresetScreen[] = input.map((raw, index) => {
    const row = raw as { arrangement?: unknown; panelIds?: unknown; columns?: unknown };
    if (!isArrangementValue(row.arrangement)) throw new HttpError(`screens[${index}].arrangement is invalid`, 400);
    if (!Array.isArray(row.panelIds)) throw new HttpError(`screens[${index}].panelIds must be an array`, 400);

    const allowed = (id: unknown): id is PanelId => {
      if (!isPanelId(id)) return false;
      const entry = PANEL_CATALOG.find((p) => p.id === id);
      return !!entry && skuAllowsPanel(sku, entry.minSku);
    };

    // Explicit columns only mean something on a Columns screen; empty columns are dropped.
    if (row.arrangement === "columns" && Array.isArray(row.columns)) {
      const columns = row.columns.map((col) => (Array.isArray(col) ? col.filter(allowed) : [])).filter((col) => col.length > 0);
      if (columns.length > 0) return { arrangement: row.arrangement, panelIds: columns.flat(), columns };
    }

    return { arrangement: row.arrangement, panelIds: row.panelIds.filter(allowed) };
  });

  if (screens.every((s) => s.panelIds.length === 0)) throw new HttpError("screens must contain at least one valid panel", 400);

  return { screens, screenCount: screens.length };
}

/**
 * A stored preset's screens with every pane id the Terminal no longer has taken out — presets
 * saved before a pane was retired still list it, and the app can't draw a pane it doesn't know.
 * Screens are kept even when emptied, so the preset's screen count doesn't change. The removed Tabs arrangement becomes Columns.
 */
export function dropUnknownPanelIds(screens: unknown): unknown {
  if (!Array.isArray(screens)) return screens;
  return screens.map((raw) => {
    const row = raw as { panelIds?: unknown; columns?: unknown };
    if (!Array.isArray(row?.panelIds)) return raw;
    const columns = Array.isArray(row.columns)
      ? row.columns.map((col) => (Array.isArray(col) ? col.filter((id: unknown) => isPanelId(id)) : [])).filter((col) => col.length > 0)
      : [];
    const arrangement = (row as { arrangement?: unknown }).arrangement;
    // The Tabs arrangement was removed; a stored preset that still uses it opens as Columns.
    return { ...row, ...(arrangement === "tabs" && { arrangement: "columns" }), panelIds: row.panelIds.filter((id: unknown) => isPanelId(id)), ...(Array.isArray(row.columns) && { columns: columns.length > 0 ? columns : undefined }) };
  });
}
