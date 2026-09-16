import { Request, Response } from "express";
import NotificationSvc from "../services/notification.service";
import HttpError from "../utils/http-error";
import { listNotificationsSchema } from "../validation/notification.validation";

export default class NotificationCtrl {
  static async list(req: Request, res: Response) {
    const { error, value } = listNotificationsSchema.validate(req.query);
    if (error) throw new HttpError(error.message, 400);

    const result = await NotificationSvc.list(req.user.userId, req.organization!.id, {
      limit: value.limit,
      cursor: value.cursor,
      unreadOnly: value.unreadOnly,
    });
    return res.status(200).json(result);
  }

  static async unreadCount(req: Request, res: Response) {
    const count = await NotificationSvc.unreadCount(req.user.userId, req.organization!.id);
    return res.status(200).json({ count });
  }

  static async markRead(req: Request, res: Response) {
    await NotificationSvc.markRead(req.params.id, req.user.userId);
    return res.status(204).send();
  }

  static async markAllRead(req: Request, res: Response) {
    await NotificationSvc.markAllRead(req.user.userId, req.organization!.id);
    return res.status(204).send();
  }
}
