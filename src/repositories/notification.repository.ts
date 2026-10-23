import prisma from "../lib/prisma";

/** The caller's notifications for a workspace: a firm's plus the global ones (no organization),
 * or in an own workspace just the ones with no organization. Always the caller's own (userId). */
function inWorkspace(organizationId: string | null) {
  return organizationId ? { OR: [{ organizationId }, { organizationId: null }] } : { organizationId: null };
}

export default class NotificationRepo {
  /**
   * organizationId is matched loosely (current org OR null) so a global/system notification
   * still shows up regardless of which org the caller is currently switched into — see the
   * model comment on Notification in schema.prisma.
   */
  static async findMany(userId: string, organizationId: string | null, filters: { limit?: number; cursor?: string; unreadOnly?: boolean } = {}) {
    const limit = filters.limit ?? 20;
    return prisma.notification.findMany({
      where: {
        userId,
        ...inWorkspace(organizationId),
        ...(filters.unreadOnly && { isRead: false }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      ...(filters.cursor && { cursor: { id: filters.cursor }, skip: 1 }),
    });
  }

  static async countUnread(userId: string, organizationId: string | null) {
    return prisma.notification.count({
      where: { userId, isRead: false, ...inWorkspace(organizationId) },
    });
  }

  static async create(data: { userId: string; organizationId?: string; type: string; title: string; message: string; link?: string }) {
    return prisma.notification.create({ data });
  }

  static async markRead(id: string, userId: string) {
    return prisma.notification.updateMany({
      where: { id, userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
  }

  static async markAllRead(userId: string, organizationId: string | null) {
    return prisma.notification.updateMany({
      where: { userId, isRead: false, ...inWorkspace(organizationId) },
      data: { isRead: true, readAt: new Date() },
    });
  }
}
