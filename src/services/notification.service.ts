import NotificationRepo from "../repositories/notification.repository";
import { emitToUser } from "../lib/socket";

export default class NotificationSvc {
  static async list(userId: string, organizationId: string, filters: { limit?: number; cursor?: string; unreadOnly?: boolean }) {
    const notifications = await NotificationRepo.findMany(userId, organizationId, filters);
    const nextCursor = filters.limit && notifications.length === filters.limit ? notifications[notifications.length - 1]!.id : null;
    return { notifications, nextCursor };
  }

  static async unreadCount(userId: string, organizationId: string) {
    return NotificationRepo.countUnread(userId, organizationId);
  }

  static async markRead(id: string, userId: string) {
    await NotificationRepo.markRead(id, userId);
  }

  static async markAllRead(userId: string, organizationId: string) {
    await NotificationRepo.markAllRead(userId, organizationId);
  }

  /**
   * The one entry point every other part of the backend should call to raise a notification
   * (the reminder queue, case-sharing, event creation, future workflow triggers) — keeps
   * row-shape validation and the real-time push in one place instead of every caller building
   * a Prisma payload by hand and remembering to emit. The socket push is a live-update
   * shortcut only: emitToUser is best-effort and never throws, so a client that's offline or
   * never connects still sees this via the normal GET /api/notifications poll/refetch.
   */
  static async create(input: { userId: string; organizationId?: string; type: "EVENT_REMINDER" | "CASE_UPDATE" | "SYSTEM"; title: string; message: string; link?: string }) {
    const notification = await NotificationRepo.create(input);
    emitToUser(input.userId, "notification:new", notification);
    return notification;
  }
}
