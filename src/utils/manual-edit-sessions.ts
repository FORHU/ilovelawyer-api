import { MANUAL_EDIT_SESSION_GAP_MS } from "../constants/manual-edit.constants";

interface EditLike {
  id: string;
  actorId: string | null;
  createdAt: Date;
}

export interface EditSession<T extends EditLike> {
  /** The session's first edit's id — stable while the session is open. */
  id: string;
  actorId: string | null;
  startedAt: Date;
  endedAt: Date;
  edits: T[];
}

/**
 * Groups edits into editing sessions: one person's edits with no gap over `gapMs` between them,
 * and no AI run (`runTimes`) in between — a run splits a session, since the "What changed" modal
 * shows the two on either side of it. Each person's edits are grouped separately, so two lawyers
 * editing at once make two sessions. Newest session first.
 */
export function groupEditSessions<T extends EditLike>(edits: T[], runTimes: Date[], gapMs = MANUAL_EDIT_SESSION_GAP_MS): EditSession<T>[] {
  const runs = runTimes.map((t) => t.getTime()).sort((a, b) => a - b);
  const runBetween = (from: number, to: number) => runs.some((t) => t > from && t <= to);
  const byActor = new Map<string, T[]>();
  for (const edit of [...edits].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const key = edit.actorId ?? "";
    byActor.set(key, [...(byActor.get(key) ?? []), edit]);
  }

  const sessions: EditSession<T>[] = [];
  for (const actorEdits of byActor.values()) {
    let current: EditSession<T> | null = null;
    for (const edit of actorEdits) {
      const at = edit.createdAt.getTime();
      const last = current?.endedAt.getTime();
      if (!current || last === undefined || at - last > gapMs || runBetween(last, at)) {
        current = { id: edit.id, actorId: edit.actorId, startedAt: edit.createdAt, endedAt: edit.createdAt, edits: [] };
        sessions.push(current);
      }
      current.edits.push(edit);
      current.endedAt = edit.createdAt;
    }
  }
  return sessions.sort((a, b) => b.endedAt.getTime() - a.endedAt.getTime());
}

/** The calendar day (YYYY-MM-DD) a moment falls on in `timeZone` — the same split the day picker
 * uses for runs (CaseChangeSummaryRepo.days). */
export function dayKeyOf(moment: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(moment);
}
