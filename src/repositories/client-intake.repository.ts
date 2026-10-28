import prisma from "../lib/prisma";
import type { CaseIntake } from "../types/client-intake";

/** What ClientIntakeSvc.generateInner reads to build the prompt: the case's own fields, its
 * parties, its ACTIVE documents, and its one consultation. Caller-scoped by caseId alone — same
 * as ClientOverviewRepo/DocumentRepo.listAllByCase — because by the time a job reaches here,
 * ClientIntakeSvc.beginQueued/scheduleAuto has already resolved the caseId from an access-checked
 * workspace. */
export interface ClientIntakeCaseSource {
  id: string;
  caseName: string;
  caseAreas: string[];
  ukJurisdiction: string | null;
  jurisdiction: string | null;
  clientSide: "CLAIMANT" | "RESPONDENT" | null;
  notes: string | null;
  lawyerReadiness: unknown;
  parties: { name: string; designation: string }[];
  documents: { id: string; name: string; ragStatus: string }[];
  consultationId: string | null;
}

export default class ClientIntakeRepo {
  static async findCaseForIntake(caseId: string): Promise<ClientIntakeCaseSource | null> {
    const row = await prisma.case.findUnique({
      where: { id: caseId },
      select: {
        id: true,
        caseName: true,
        caseAreas: true,
        ukJurisdiction: true,
        jurisdiction: true,
        clientSide: true,
        notes: true,
        lawyerReadiness: true,
        parties: { select: { name: true, designation: true }, orderBy: { id: "asc" } },
        documents: { where: { status: "ACTIVE" }, select: { id: true, name: true, ragStatus: true }, orderBy: { createdAt: "asc" } },
        consultations: { where: { status: "ACTIVE" }, select: { id: true }, orderBy: { createdAt: "asc" }, take: 1 },
      },
    });
    if (!row) return null;
    return { ...row, consultationId: row.consultations[0]?.id ?? null };
  }

  static async find(caseId: string) {
    return prisma.caseClientIntake.findUnique({ where: { caseId } });
  }

  /** Written once a run produces usable content, or is given up on with `data: null` after a
   * parse failure that leaves nothing to show — see ClientOverviewRepo.saveResult, same shape. */
  static async saveResult(caseId: string, data: { data: CaseIntake | null; fingerprint: string }) {
    await prisma.caseClientIntake.upsert({
      where: { caseId },
      create: { caseId, generatedAt: new Date(), data: data.data as object | undefined, fingerprint: data.fingerprint },
      update: { generatedAt: new Date(), data: data.data as object | undefined, fingerprint: data.fingerprint },
    });
  }

  /** Same daily-cap bookkeeping as ClientOverviewRepo.claimDailyRun, kept separate so the
   * intake's own cap never contends with the (to-be-retired) overview's. */
  static async claimDailyRun(caseId: string, today: Date, cap: number): Promise<{ leftToday: number } | null> {
    const existing = await prisma.caseClientIntake.findUnique({ where: { caseId }, select: { runDay: true, runsOnDay: true } });
    if (!existing) {
      await prisma.caseClientIntake.create({ data: { caseId, runDay: today, runsOnDay: 1 } });
      return { leftToday: cap - 1 };
    }
    const sameDay = existing.runDay && isSameUtcDate(existing.runDay, today);
    const usedSoFar = sameDay ? existing.runsOnDay : 0;
    if (usedSoFar >= cap) return null;
    await prisma.caseClientIntake.update({ where: { caseId }, data: { runDay: today, runsOnDay: usedSoFar + 1 } });
    return { leftToday: cap - (usedSoFar + 1) };
  }

  static usedToday(stored: { runDay: Date | null; runsOnDay: number } | null): number {
    return stored?.runDay && isSameUtcDate(stored.runDay, new Date()) ? stored.runsOnDay : 0;
  }
}

function isSameUtcDate(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}
