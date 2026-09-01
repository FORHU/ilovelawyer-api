import prisma from "../lib/prisma";
import { TimelineSource } from "@prisma/client";
import { AI_KEY_DATE_STATUS } from "../constants/case-strategy.constants";

export interface TimelineInput {
  title: string;
  occurredOn?: Date | null;
  description?: string | null;
  status?: string;
  source?: TimelineSource;
  documentId?: string | null;
  chunkId?: string | null;
  pageNumber?: number | null;
  createdBy?: string | null;
}

export default class CaseTimelineRepo {
  static async list(caseId: string) {
    return prisma.caseTimelineEvent.findMany({
      where: { caseId },
      orderBy: [{ occurredOn: "asc" }, { createdAt: "asc" }],
    });
  }

  static async create(caseId: string, data: TimelineInput) {
    return prisma.caseTimelineEvent.create({ data: { caseId, ...data } });
  }

  static async createMany(caseId: string, items: TimelineInput[]) {
    if (items.length === 0) return { count: 0 };
    return prisma.caseTimelineEvent.createMany({
      data: items.map((item) => ({ caseId, ...item })),
    });
  }

  static async replaceAiKeyDates(
    caseId: string,
    items: { title: string; occurredOn: Date; createdBy?: string | null }[],
  ) {
    await prisma.$transaction(async (tx) => {
      await tx.caseTimelineEvent.deleteMany({ where: { caseId, source: "AI", status: AI_KEY_DATE_STATUS } });
      if (items.length === 0) return;
      await tx.caseTimelineEvent.createMany({
        data: items.map((item) => ({
          caseId,
          title: item.title,
          occurredOn: item.occurredOn,
          status: AI_KEY_DATE_STATUS,
          source: "AI",
          createdBy: item.createdBy ?? null,
        })),
      });
    });
    return this.list(caseId);
  }

  static async findById(id: string, caseId: string) {
    return prisma.caseTimelineEvent.findFirst({ where: { id, caseId } });
  }

  static async update(id: string, caseId: string, data: Partial<TimelineInput>) {
    const existing = await prisma.caseTimelineEvent.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    return prisma.caseTimelineEvent.update({ where: { id }, data });
  }

  static async delete(id: string, caseId: string) {
    const result = await prisma.caseTimelineEvent.deleteMany({ where: { id, caseId } });
    return result.count > 0;
  }
}
