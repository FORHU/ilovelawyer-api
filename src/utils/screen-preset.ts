import { ArrangementValue, PanelId, PANEL_CATALOG, skuAllowsPanel } from "../constants";
import { isArrangementValue, isPanelId } from "./terminal-layout";
import HttpError from "./http-error";

export interface ScreenPresetScreen {
  arrangement: ArrangementValue;
  panelIds: PanelId[];
}

// Validates a preset's `screens` against this user's own sku (same catalog/sku gate
// normalizeLayout uses) and computes screenCount from the result — throws rather than silently
// dropping bad input, since (unlike a workspace layout) a preset is a deliberate lawyer-authored
// template, not a save-as-you-go autosave that has to tolerate a stray bad field.
export function normalizeScreenPresetScreens(input: unknown, sku: string): { screens: ScreenPresetScreen[]; screenCount: number } {
  if (!Array.isArray(input) || input.length === 0) throw new HttpError("screens must be a non-empty array", 400);

  const screens: ScreenPresetScreen[] = input.map((raw, index) => {
    const row = raw as { arrangement?: unknown; panelIds?: unknown };
    if (!isArrangementValue(row.arrangement)) throw new HttpError(`screens[${index}].arrangement is invalid`, 400);
    if (!Array.isArray(row.panelIds)) throw new HttpError(`screens[${index}].panelIds must be an array`, 400);

    const panelIds = row.panelIds.filter((id: unknown): id is PanelId => {
      if (!isPanelId(id)) return false;
      const entry = PANEL_CATALOG.find((p) => p.id === id);
      return !!entry && skuAllowsPanel(sku, entry.minSku);
    });

    return { arrangement: row.arrangement, panelIds };
  });

  if (screens.every((s) => s.panelIds.length === 0)) throw new HttpError("screens must contain at least one valid panel", 400);

  return { screens, screenCount: screens.length };
}
