import prisma from "../lib/prisma";
import { BookmarkType } from "@prisma/client";
import { organizationIdOf, scopeWhere, type WorkspaceScope } from "../utils/workspace";

/** A workspace's bookmarks: shared across a firm, or a solo lawyer's own. */
export default class BookmarkRepo {
  /** userId is stamped for "created by" audit purposes only — reads/deletes below scope by the
   * workspace (in an own workspace that is the owner, see scopeWhere). */
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
    return prisma.bookmark.create({ data: { organizationId: organizationIdOf(scope), userId, ...data } });
  }

  static async list(scope: WorkspaceScope) {
    return prisma.bookmark.findMany({
      where: scopeWhere(scope),
      orderBy: { createdAt: "desc" },
    });
  }

  static async findById(id: string, scope: WorkspaceScope) {
    return prisma.bookmark.findFirst({ where: { id, ...scopeWhere(scope) } });
  }

  /** Not the (organizationId, itemId) unique key: in an own workspace organizationId is null, which
   * a unique key treats as distinct, so the item is looked up within the workspace instead. */
  static async findByItemId(scope: WorkspaceScope, itemId: string) {
    return prisma.bookmark.findFirst({
      where: { ...scopeWhere(scope), itemId },
      select: { id: true },
    });
  }

  static async delete(id: string, scope: WorkspaceScope) {
    const result = await prisma.bookmark.deleteMany({ where: { id, ...scopeWhere(scope) } });
    return result.count > 0;
  }
}
