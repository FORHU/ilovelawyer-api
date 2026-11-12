import type { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { SUPPORT_DRAFT_ID as DRAFT_ID } from "../constants/support-content.constants";

export default class SupportContentRepo {
  static async findDraft() {
    return prisma.supportContentDraft.findUnique({ where: { id: DRAFT_ID } });
  }

  static async ensureDraft(content: Prisma.InputJsonValue, basedOnVersion: number | null, updatedById: string | null) {
    return prisma.supportContentDraft.upsert({
      where: { id: DRAFT_ID },
      create: { id: DRAFT_ID, content, basedOnVersion, updatedById },
      update: {},
    });
  }

  /** Saves the draft only if it still has the updatedAt the editor loaded. Returns false when it changed. */
  static async updateDraftIfUnchanged(expectedUpdatedAt: Date, content: Prisma.InputJsonValue, updatedById: string): Promise<boolean> {
    const { count } = await prisma.supportContentDraft.updateMany({
      where: { id: DRAFT_ID, updatedAt: expectedUpdatedAt },
      data: { content, updatedById },
    });
    return count === 1;
  }

  static async resetDraft(content: Prisma.InputJsonValue, basedOnVersion: number, updatedById: string | null, tx: Prisma.TransactionClient = prisma) {
    return tx.supportContentDraft.upsert({
      where: { id: DRAFT_ID },
      create: { id: DRAFT_ID, content, basedOnVersion, updatedById },
      update: { content, basedOnVersion, updatedById },
    });
  }

  static async findLatestVersion(tx: Prisma.TransactionClient = prisma) {
    return tx.supportContentVersion.findFirst({ orderBy: { version: "desc" } });
  }

  static async findVersion(version: number) {
    return prisma.supportContentVersion.findUnique({ where: { version } });
  }

  static async listVersions() {
    return prisma.supportContentVersion.findMany({
      orderBy: { version: "desc" },
      select: { version: true, publishedAt: true, publishedById: true, rolledBackFromVersion: true },
    });
  }

  static async createVersion(
    data: { version: number; content: Prisma.InputJsonValue; publishedById: string | null; rolledBackFromVersion?: number },
    tx: Prisma.TransactionClient = prisma,
  ) {
    return tx.supportContentVersion.create({ data });
  }

  static async userNames(ids: string[]): Promise<Map<string, { id: string; name: string | null; email: string }>> {
    if (ids.length === 0) return new Map();
    const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } });
    return new Map(users.map((u) => [u.id, u]));
  }
}
