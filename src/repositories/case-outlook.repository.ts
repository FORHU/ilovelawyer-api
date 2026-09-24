import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { ParsedCaseOutlook } from "../utils/case-outlook-parse";

// Append-only — there is deliberately no update or delete here (see the CaseOutlook schema comment).
export default class CaseOutlookRepo {
  static async insert(caseId: string, outlook: ParsedCaseOutlook) {
    return prisma.caseOutlook.create({
      data: {
        caseId,
        band: outlook.band,
        confidence: outlook.confidence,
        rationale: outlook.rationale,
        drivers: outlook.drivers as unknown as Prisma.InputJsonValue,
      },
    });
  }

  static async latest(caseId: string) {
    return prisma.caseOutlook.findFirst({ where: { caseId }, orderBy: { createdAt: "desc" } });
  }

  /** Band + confidence only, newest first — enough for a history strip without shipping every rationale. */
  static async history(caseId: string, limit: number) {
    return prisma.caseOutlook.findMany({
      where: { caseId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, band: true, confidence: true, createdAt: true },
    });
  }
}
