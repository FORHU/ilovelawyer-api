import CaseManualEditRepo from "../repositories/case-manual-edit.repository";
import { getRequestContext } from "../lib/request-context";
import { ManualEditChange, ManualEditEntry } from "../types/manual-edit";
import { mergeEditChanges } from "../utils/manual-edit-changes";
import { MANUAL_EDIT_COLLAPSE_MS, MANUAL_EDIT_LABEL_MAX } from "../constants/manual-edit.constants";
import logger from "../utils/logger";

/**
 * Records a lawyer's edit in a Terminal pane for the Change Summary (CaseManualEdit). Called by
 * each pane's edit method right after its write succeeds — never by the AI's own writes, which
 * show up as runs instead.
 *
 * Never throws: a lost log row must not fail the edit it describes. An "edited" row with nothing
 * changed is skipped, and the same person editing the same item again within
 * MANUAL_EDIT_COLLAPSE_MS folds into their earlier row, so autosave reads as one edit.
 */
export default class ManualEditLog {
  static async record(caseId: string, actorId: string | null | undefined, entry: ManualEditEntry): Promise<void> {
    try {
      const actor = actorId ?? getRequestContext()?.userId() ?? null;
      const label = (entry.label || "").trim().slice(0, MANUAL_EDIT_LABEL_MAX) || "Untitled";
      if (entry.action === "edited") {
        const changes = entry.changes ?? [];
        if (changes.length === 0) return;
        if (actor && entry.itemId && (await ManualEditLog.collapse(caseId, actor, entry, label, changes))) return;
      }
      await CaseManualEditRepo.create(caseId, actor, { ...entry, label });
    } catch (err) {
      logger.warn("Manual edit not recorded", { err, caseId, pane: entry.pane, kind: entry.kind, action: entry.action });
    }
  }

  /** Folds this edit into the same person's recent edit of the same item. True when it did. */
  private static async collapse(caseId: string, actorId: string, entry: ManualEditEntry, label: string, changes: ManualEditChange[]) {
    const since = new Date(Date.now() - MANUAL_EDIT_COLLAPSE_MS);
    const recent = await CaseManualEditRepo.findRecentEdit(caseId, actorId, entry.kind, entry.itemId!, since);
    if (!recent) return false;
    const merged = mergeEditChanges((recent.changes as ManualEditChange[] | null) ?? [], changes);
    // Edited back to where it started: the edit undid itself.
    if (merged.length === 0) await CaseManualEditRepo.remove(recent.id);
    else await CaseManualEditRepo.updateChanges(recent.id, label, merged);
    return true;
  }
}
