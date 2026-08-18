import prisma from "../lib/prisma";
import { BookmarkType } from "@prisma/client";

export default class BookmarkRepo {
  /** userId is stamped for "created by" audit purposes only — reads/deletes below scope by organizationId. */
  static async create(
    organizationId: string,
    userId: string,
    data: {
      itemId: string;
      title: string;
      type: BookmarkType;
      reference?: string;
      url?: string;
      aiSummary?: string;
      doctrine?: string;
      facts?: string;
    },
  ) {
    return prisma.bookmark.create({ data: { organizationId, userId, ...data } });
  }

  static async list(organizationId: string) {
    return prisma.bookmark.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
    });
  }

  static async findById(id: string, organizationId: string) {
    return prisma.bookmark.findFirst({ where: { id, organizationId } });
  }

  static async findByItemId(organizationId: string, itemId: string) {
    return prisma.bookmark.findUnique({
      where: { organizationId_itemId: { organizationId, itemId } },
      select: { id: true },
    });
  }

  static async delete(id: string, organizationId: string) {
    const result = await prisma.bookmark.deleteMany({ where: { id, organizationId } });
    return result.count > 0;
  }
}
