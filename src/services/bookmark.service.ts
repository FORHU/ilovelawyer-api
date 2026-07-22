import BookmarkRepo from "../repositories/bookmark.repository";
import HttpError from "../utils/http-error";
import { BookmarkType } from "@prisma/client";

export default class BookmarkSvc {
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
    const existing = await BookmarkRepo.findByItemId(userId, data.itemId);
    if (existing) throw new HttpError("Item already bookmarked", 409);
    return BookmarkRepo.create(userId, data);
  }

  static async list(userId: string) {
    return BookmarkRepo.list(userId);
  }

  static async getById(id: string, userId: string) {
    const bookmark = await BookmarkRepo.findById(id, userId);
    if (!bookmark) throw new HttpError("Bookmark not found", 404);
    return bookmark;
  }

  static async checkByItemId(userId: string, itemId: string) {
    const row = await BookmarkRepo.findByItemId(userId, itemId);
    return { bookmarkId: row?.id ?? null };
  }

  static async delete(id: string, userId: string) {
    const deleted = await BookmarkRepo.delete(id, userId);
    if (!deleted) throw new HttpError("Bookmark not found", 404);
  }
}
