import BookmarkRepo from "../repositories/bookmark.repository";
import HttpError from "../utils/http-error";
import { BookmarkType } from "@prisma/client";
import type { WorkspaceScope } from "../utils/workspace";

export default class BookmarkSvc {
  static async create(
    scope: WorkspaceScope,
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
    const existing = await BookmarkRepo.findByItemId(scope, data.itemId);
    if (existing) throw new HttpError("Item already bookmarked", 409);
    return BookmarkRepo.create(scope, userId, data);
  }

  static async list(scope: WorkspaceScope) {
    return BookmarkRepo.list(scope);
  }

  static async getById(id: string, scope: WorkspaceScope) {
    const bookmark = await BookmarkRepo.findById(id, scope);
    if (!bookmark) throw new HttpError("Bookmark not found", 404);
    return bookmark;
  }

  static async checkByItemId(scope: WorkspaceScope, itemId: string) {
    const row = await BookmarkRepo.findByItemId(scope, itemId);
    return { bookmarkId: row?.id ?? null };
  }

  static async delete(id: string, scope: WorkspaceScope) {
    const deleted = await BookmarkRepo.delete(id, scope);
    if (!deleted) throw new HttpError("Bookmark not found", 404);
  }
}
