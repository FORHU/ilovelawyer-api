import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { CaseChangeDeltas, CaseChangeReason, ChangedDocument } from "../types/case-change";

export interface CaseChangeSummaryInput {
  id: string;
  caseId: string;
  reason: CaseChangeReason;
  actorId: string | null;
  readyDocumentIds: string[];
  documentsAdded: ChangedDocument[];
  documentsRemoved: ChangedDocument[];
  totalChanges: number;
  firstAnalysis: boolean;
  perPaneDeltas: CaseChangeDeltas;
}

// Written once per refresh, never updated — see the CaseChangeSummary schema comment.
export default class CaseChangeSummaryRepo {
  static async create(data: CaseChangeSummaryInput) {
    return prisma.caseChangeSummary.create({
      data: {
        ...data,
        documentsAdded: data.documentsAdded as unknown as Prisma.InputJsonValue,
        documentsRemoved: data.documentsRemoved as unknown as Prisma.InputJsonValue,
        perPaneDeltas: data.perPaneDeltas as unknown as Prisma.InputJsonValue,
      },
    });
  }

  static async latest(caseId: string) {
    return prisma.caseChangeSummary.findFirst({ where: { caseId }, orderBy: { createdAt: "desc" } });
  }

  /** The latest summary of a whole-case refresh (not a pane's Regenerate) — the baseline for
   * which documents are new. */
  static async latestRefresh(caseId: string) {
    return prisma.caseChangeSummary.findFirst({
      where: { caseId, reason: { in: ["manual", "post-extraction"] } },
      orderBy: { createdAt: "desc" },
    });
  }

  static async list(caseId: string, limit: number) {
    return prisma.caseChangeSummary.findMany({ where: { caseId }, orderBy: { createdAt: "desc" }, take: limit });
  }

  /** The case's summaries made on one calendar day (`day`, YYYY-MM-DD) in time zone `tz`, newest
   * first. The day's bounds are worked out in Postgres, so daylight-saving days are right. */
  static async listOnDay(caseId: string, day: string, tz: string, limit: number) {
    const [bounds] = await prisma.$queryRaw<{ start: Date; end: Date }[]>`
      SELECT (${day}::date::timestamp AT TIME ZONE ${tz}) AS "start",
             ((${day}::date + 1)::timestamp AT TIME ZONE ${tz}) AS "end"`;
    if (!bounds) return [];
    return prisma.caseChangeSummary.findMany({
      where: { caseId, createdAt: { gte: bounds.start, lt: bounds.end } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  /** The calendar days (in time zone `tz`) the case has summaries on, newest first, with how many
   * runs each day had and the changes they counted (a first analysis counts none). createdAt is
   * stored as UTC without a zone, hence the AT TIME ZONE 'UTC' first. */
  static async days(caseId: string, tz: string, limit: number) {
    return prisma.$queryRaw<{ day: string; runs: number; totalChanges: number }[]>`
      SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS "day",
             count(*)::int AS "runs",
             coalesce(sum(CASE WHEN "firstAnalysis" THEN 0 ELSE "totalChanges" END), 0)::int AS "totalChanges"
      FROM "CaseChangeSummary"
      WHERE "caseId" = ${caseId}
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT ${limit}`;
  }
}
