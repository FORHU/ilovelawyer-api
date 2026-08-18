import BookmarkRepo from "../repositories/bookmark.repository";
import HttpError from "../utils/http-error";
import { BookmarkType } from "@prisma/client";

export default class BookmarkSvc {
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
    const existing = await BookmarkRepo.findByItemId(organizationId, data.itemId);
    if (existing) throw new HttpError("Item already bookmarked", 409);
    return BookmarkRepo.create(organizationId, userId, data);
  }

  static async list(organizationId: string) {
    return BookmarkRepo.list(organizationId);
  }

  static async getById(id: string, organizationId: string) {
    const bookmark = await BookmarkRepo.findById(id, organizationId);
    if (!bookmark) throw new HttpError("Bookmark not found", 404);
    return bookmark;
  }

  static async checkByItemId(organizationId: string, itemId: string) {
    const row = await BookmarkRepo.findByItemId(organizationId, itemId);
    return { bookmarkId: row?.id ?? null };
  }

  static async delete(id: string, organizationId: string) {
    const deleted = await BookmarkRepo.delete(id, organizationId);
    if (!deleted) throw new HttpError("Bookmark not found", 404);
  }
}
