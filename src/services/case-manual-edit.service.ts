import CaseAccess from "../utils/case-access";
import CaseManualEditRepo from "../repositories/case-manual-edit.repository";
import CaseChangeSummaryRepo from "../repositories/case-change-summary.repository";
import HttpError from "../utils/http-error";
import { groupEditSessions } from "../utils/manual-edit-sessions";
import { resolveTimeZone } from "./case-change.service";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

type EditRow = Awaited<ReturnType<typeof CaseManualEditRepo.listBetween>>[number];

/** An editing session as the "What changed" modal reads it. */
function sessionView(session: ReturnType<typeof groupEditSessions<EditRow>>[number]) {
  const actor = session.edits[0]?.actor;
  return {
    id: session.id,
    actorId: session.actorId,
    actorName: actor?.name || actor?.username || null,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    editCount: session.edits.length,
    edits: session.edits.map((e) => ({
      id: e.id,
      pane: e.pane,
      kind: e.kind,
      itemId: e.itemId,
      action: e.action,
      label: e.label,
      changes: e.changes,
      createdAt: e.createdAt,
    })),
  };
}

export default class CaseManualEditSvc {
  /** One calendar day's editing sessions (`day` YYYY-MM-DD in the viewer's time zone `tz`), newest
   * first. Anyone who can open the case can read them, like the runs beside them. */
  static async sessionsOnDay(caseId: string, userId: string, day: unknown, tz: unknown) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    if (typeof day !== "string" || !DAY.test(day) || Number.isNaN(Date.parse(day))) {
      throw new HttpError("day must be a date as YYYY-MM-DD", 400);
    }
    const bounds = await CaseChangeSummaryRepo.dayBounds(day, resolveTimeZone(tz));
    if (!bounds) return [];
    const [edits, runTimes] = await Promise.all([
      CaseManualEditRepo.listBetween(caseId, new Date(bounds.start.getTime() - 1), bounds.end),
      CaseChangeSummaryRepo.listTimes(caseId, bounds.start, bounds.end),
    ]);
    return groupEditSessions(edits, runTimes).map(sessionView);
  }

  /** The edits lawyers made between the previous run's save and this run's start — the line a
   * run's view shows ("5 edits since the previous run, by …"). Edits made while the run worked
   * aren't counted; a run from before startedAt existed falls back to its save time. */
  static async beforeRun(caseId: string, userId: string, summaryId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    const run = await CaseChangeSummaryRepo.findById(summaryId, caseId);
    if (!run) throw new HttpError("Change summary not found", 404);
    const until = run.startedAt ?? run.createdAt;
    const previous = await CaseChangeSummaryRepo.previousBefore(caseId, until);
    const edits = await CaseManualEditRepo.listBetween(caseId, previous?.createdAt ?? null, until);
    const sessions = groupEditSessions(edits, []).map(sessionView);
    const actors = new Map<string, { id: string | null; name: string | null }>();
    for (const s of sessions) actors.set(s.actorId ?? "", { id: s.actorId, name: s.actorName });
    // Oldest first, so "the first of those sessions" is the one that started earliest.
    const first = [...sessions].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())[0];
    return {
      count: edits.length,
      actors: [...actors.values()],
      firstSession: first ? { id: first.id, startedAt: first.startedAt } : null,
    };
  }
}
