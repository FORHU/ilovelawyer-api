import CaseAccess from "../utils/case-access";
import CaseChangeSummaryRepo from "../repositories/case-change-summary.repository";
import CaseManualEditRepo from "../repositories/case-manual-edit.repository";
import { dayKeyOf, groupEditSessions } from "../utils/manual-edit-sessions";
import HttpError from "../utils/http-error";
import { CASE_CHANGE_SUMMARY_DAYS_LIMIT, CASE_CHANGE_SUMMARY_LIST_LIMIT } from "../constants";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The viewer's IANA time zone (e.g. "Asia/Manila"), or UTC when none or an unknown one is given —
 * days are grouped the way the viewer's own calendar splits them. */
export function resolveTimeZone(tz: unknown): string {
  if (typeof tz !== "string" || !tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

export default class CaseChangeSvc {
  /** Newest first. Anyone who can open the case can read them — they describe the case's shared
   * analysis, the same panes every viewer of the Terminal reads. With `day` (YYYY-MM-DD, read in
   * time zone `tz`), only that day's. */
  static async list(caseId: string, userId: string, options: { limit?: number; day?: unknown; tz?: unknown } = {}) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    const limit = Math.min(Math.max(1, options.limit ?? CASE_CHANGE_SUMMARY_LIST_LIMIT), CASE_CHANGE_SUMMARY_LIST_LIMIT);
    if (options.day === undefined) return CaseChangeSummaryRepo.list(caseId, limit);
    if (typeof options.day !== "string" || !DAY.test(options.day) || Number.isNaN(Date.parse(options.day))) {
      throw new HttpError("day must be a date as YYYY-MM-DD", 400);
    }
    return CaseChangeSummaryRepo.listOnDay(caseId, options.day, resolveTimeZone(options.tz), limit);
  }

  /** The days the case has change summaries or lawyers' editing sessions on, in the viewer's time
   * zone, newest first — the "What changed" modal's date picker. A session counts on the day it
   * started. */
  static async days(caseId: string, userId: string, tz: unknown) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    const zone = resolveTimeZone(tz);
    const [runDays, edits, runTimes] = await Promise.all([
      CaseChangeSummaryRepo.days(caseId, zone, CASE_CHANGE_SUMMARY_DAYS_LIMIT),
      CaseManualEditRepo.listTimes(caseId),
      CaseChangeSummaryRepo.listTimes(caseId),
    ]);
    const days = new Map(runDays.map((d) => [d.day, { ...d, editSessions: 0 }]));
    for (const session of groupEditSessions(edits, runTimes)) {
      const day = dayKeyOf(session.startedAt, zone);
      const entry = days.get(day) ?? { day, runs: 0, totalChanges: 0, editSessions: 0 };
      entry.editSessions += 1;
      days.set(day, entry);
    }
    return [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, CASE_CHANGE_SUMMARY_DAYS_LIMIT);
  }
}
