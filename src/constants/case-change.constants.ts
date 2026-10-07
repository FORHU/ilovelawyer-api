/** Most added or dropped contradictions a CaseChangeSummary lists by name — a full-bundle scan
 * can find hundreds. The counts beside each list stay exact; only the names are capped. */
export const CASE_CHANGE_MAX_LISTED = 20;

/** Smallest move in Red Team's risk of loss (percentage points) that counts as a change. The
 * number is re-estimated on every run, so a point or two either way is noise, not the case moving. */
export const CASE_CHANGE_RISK_OF_LOSS_THRESHOLD = 5;

/** Smallest move in a witness's shown credibility score (0-100) that counts as a change. Re-scoring
 * re-reads the documents each run, so a few points either way is noise. */
export const CASE_CHANGE_CREDIBILITY_THRESHOLD = 10;

/** Most change summaries GET /:caseId/change-summaries returns at once. */
export const CASE_CHANGE_SUMMARY_LIST_LIMIT = 50;
