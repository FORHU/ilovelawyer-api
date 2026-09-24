import { RiskSeverity } from "@prisma/client";

// Decisions behind the case outlook (Case Outlook task board, step 1). Recommended answers
// adopted; the confidence-cap numbers still need product sign-off.
//  - Regenerated on every case refresh (CaseRefreshSvc.refreshInner), same trigger as risks.
//  - No case-health sparkline in v1, so no CaseScoreSnapshot history table.
//  - No backfill: existing cases get an outlook on their next refresh.
//  - An "AI assessment, not legal advice" line under the gauge (OUTLOOK_DISCLAIMER below).

/** Fewer READY documents than this and the outlook's confidence is forced to LOW. */
export const OUTLOOK_MIN_READY_DOCS = 3;

/** Any OPEN risk with one of these severities also forces confidence to LOW. */
export const OUTLOOK_LOW_CONFIDENCE_RISK_SEVERITIES: readonly RiskSeverity[] = ["FATAL", "MISSING_EVIDENCE"];

/** Shown under the outlook gauge. Sent with the outlook so every client shows the same wording. */
export const OUTLOOK_DISCLAIMER = "AI assessment, not legal advice.";

/** How many past outlooks the snapshot returns in `outlookHistory`. */
export const OUTLOOK_HISTORY_LIMIT = 20;

/** Weeks of history in the snapshot's KPI-tile trends. */
export const CASE_TREND_WEEKS = 12;
