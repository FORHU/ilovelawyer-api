import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";
import type { ReconstructionEvent } from "../utils/case-reconstruction-events-parse";

export default class CaseReconstructionEventsRepo {
  /** The stored chain, or null when none has been generated. */
  static async get(caseId: string): Promise<{ events: ReconstructionEvent[]; updatedAt: Date } | null> {
    const row = await prisma.caseReconstructionEvents.findUnique({ where: { caseId } });
    return row ? { events: row.events as unknown as ReconstructionEvent[], updatedAt: row.updatedAt } : null;
  }

  static async upsert(caseId: string, events: ReconstructionEvent[]) {
    const json = events as unknown as Prisma.InputJsonValue;
    return prisma.caseReconstructionEvents.upsert({
      where: { caseId },
      create: { caseId, events: json },
      update: { events: json },
    });
  }
}
