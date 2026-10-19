/** What kind of thing a GENERAL submission is about. A string column, so adding one here never needs a migration. */
export const FEEDBACK_CATEGORIES = ["BUG", "WRONG_ANSWER", "IDEA", "QUESTION"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const FEEDBACK_COMMENT_MAX_CHARS = 1000;

/** The label bound into the sealed comment (see field-crypto): <Model>.<field>, so the data export can open it. */
export const FEEDBACK_COMMENT_LABEL = "Feedback.comment";
