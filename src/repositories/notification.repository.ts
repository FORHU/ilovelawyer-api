import prisma from "../lib/prisma";

export default class NotificationRepo {
  /**
   * organizationId is matched loosely (current org OR null) so a global/system notification
   * still shows up regardless of which org the caller is currently switched into — see the
   * model comment on Notification in schema.prisma.
   */
  static async findMany(userId: string, organizationId: string, filters: { limit?: number; cursor?: string; unreadOnly?: boolean } = {}) {
    const limit = filters.limit ?? 20;
    return prisma.notification.findMany({
      where: {
        userId,
        OR: [{ organizationId }, { organizationId: null }],
        ...(filters.unreadOnly && { isRead: false }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      ...(filters.cursor && { cursor: { id: filters.cursor }, skip: 1 }),
    });
  }

  static async countUnread(userId: string, organizationId: string) {
    return prisma.notification.count({
      where: { userId, isRead: false, OR: [{ organizationId }, { organizationId: null }] },
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

  static async markAllRead(userId: string, organizationId: string) {
    return prisma.notification.updateMany({
      where: { userId, isRead: false, OR: [{ organizationId }, { organizationId: null }] },
      data: { isRead: true, readAt: new Date() },
    });
  }
}
