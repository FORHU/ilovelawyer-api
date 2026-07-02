import prisma from "../lib/prisma";
import { BookmarkType } from "@prisma/client";

export default class BookmarkRepo {
  static async create(
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
    return prisma.bookmark.create({ data: { userId, ...data } });
  }

  static async list(userId: string) {
    return prisma.bookmark.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  static async findById(id: string, userId: string) {
    return prisma.bookmark.findFirst({ where: { id, userId } });
  }

  static async findByItemId(userId: string, itemId: string) {
    return prisma.bookmark.findUnique({
      where: { userId_itemId: { userId, itemId } },
      select: { id: true },
    });
  }

  static async delete(id: string, userId: string) {
    const result = await prisma.bookmark.deleteMany({ where: { id, userId } });
    return result.count > 0;
  }
}
