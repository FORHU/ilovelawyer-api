/** The same person editing the same item again within this long folds into one recorded edit, so a
 * pane that saves as the lawyer types reads as one change ("Impact 2 → 5", not four rows). */
export const MANUAL_EDIT_COLLAPSE_MS = 5 * 60 * 1000;

/** Longest gap between one person's edits that still counts as the same editing session. An AI run
 * between two edits also ends the session. */
export const MANUAL_EDIT_SESSION_GAP_MS = 30 * 60 * 1000;

/** An item's name is cut to this length in the log. */
export const MANUAL_EDIT_LABEL_MAX = 200;
