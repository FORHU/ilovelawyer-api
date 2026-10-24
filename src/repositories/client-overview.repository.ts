import prisma from "../lib/prisma";
import type { OverviewPane } from "../types/client-overview";

export type ClientOverviewPanes = Partial<Record<OverviewPane, "DONE" | "FAILED">>;

export default class ClientOverviewRepo {
  static async find(caseId: string) {
    return prisma.caseClientOverview.findUnique({ where: { caseId } });
  }

  /** Written once a run finishes with at least one pane successful — see
   * ClientOverviewSvc.generateInner. `panes` replaces the whole map: a pane this run didn't touch
   * keeps no stale entry from a previous run, since every run always attempts every pane. */
  static async saveResult(
    caseId: string,
    data: { summary: string | null; panes: ClientOverviewPanes; readySetFingerprint: string; documentIds: string[] },
  ) {
    await prisma.caseClientOverview.upsert({
      where: { caseId },
      create: { caseId, generatedAt: new Date(), ...data },
      update: { generatedAt: new Date(), ...data },
    });
  }

  /** Atomically claims one of today's runs against the daily cap (D1): creates the row at count 1
   * on a case with none yet, rolls `runDay`/`runsOnDay` over to 1 on a new UK day, or increments
   * when still under CLIENT_OVERVIEW_DAILY_CAP today. Returns null (nothing claimed, nothing
   * written) once today's cap is already used — the caller refuses the request with that. */
  static async claimDailyRun(caseId: string, today: Date, cap: number): Promise<{ leftToday: number } | null> {
    const existing = await prisma.caseClientOverview.findUnique({ where: { caseId }, select: { runDay: true, runsOnDay: true } });
    if (!existing) {
      await prisma.caseClientOverview.create({ data: { caseId, runDay: today, runsOnDay: 1 } });
      return { leftToday: cap - 1 };
    }
    const sameDay = existing.runDay && isSameUtcDate(existing.runDay, today);
    const usedSoFar = sameDay ? existing.runsOnDay : 0;
    if (usedSoFar >= cap) return null;
    await prisma.caseClientOverview.update({ where: { caseId }, data: { runDay: today, runsOnDay: usedSoFar + 1 } });
    return { leftToday: cap - (usedSoFar + 1) };
  }
}

function isSameUtcDate(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}
