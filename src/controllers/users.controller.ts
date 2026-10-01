import { Request, Response } from "express";
import UsersSvc from "../services/users.service";
import AvatarSvc from "../services/avatar.service";
import GoogleCalendarSvc from "../services/google-calendar.service";
import HttpError from "../utils/http-error";
import { updateMeSchema, changePasswordSchema, connectGoogleCalendarSchema } from "../validation/users.validation";

export default class UsersCtrl {
  static async me(req: Request, res: Response) {
    const user = await UsersSvc.getMe(req.user.userId);
    return res.status(200).json(user);
  }

  static async updateMe(req: Request, res: Response) {
    const { name, username } = req.body;

    const { error, value } = updateMeSchema.validate({ name, username });
    if (error) throw new HttpError(error.message, 400);

    const user = await UsersSvc.updateMe(req.user.userId, value);
    return res.status(200).json(user);
  }

  static async changePassword(req: Request, res: Response) {
    const { currentPassword, newPassword } = req.body;

    const { error, value } = changePasswordSchema.validate({ currentPassword, newPassword });
    if (error) throw new HttpError(error.message, 400);

    await UsersSvc.changePassword(req.user.userId, value.currentPassword, value.newPassword);
    return res.status(200).json({ message: "Password updated successfully" });
  }

  static async deleteMe(req: Request, res: Response) {
    const user = await UsersSvc.requestDeletion(req.user.userId);
    return res.status(200).json(user);
  }

  static async cancelDeletion(req: Request, res: Response) {
    const user = await UsersSvc.cancelDeletion(req.user.userId);
    return res.status(200).json(user);
  }

  static async uploadAvatar(req: Request, res: Response) {
    if (!req.file) throw new HttpError("No image uploaded (multipart field \"avatar\")", 400);
    const user = await AvatarSvc.setAvatar(req.user.userId, req.file.buffer);
    return res.status(200).json(user);
  }

  static async removeAvatar(req: Request, res: Response) {
    const user = await AvatarSvc.removeAvatar(req.user.userId);
    return res.status(200).json(user);
  }

  static async connectGoogleCalendar(req: Request, res: Response) {
    const { error, value } = connectGoogleCalendarSchema.validate({ code: req.body?.code });
    if (error) throw new HttpError(error.message, 400);

    const user = await GoogleCalendarSvc.connect(req.user.userId, value.code);
    return res.status(200).json(user);
  }

  static async disconnectGoogleCalendar(req: Request, res: Response) {
    const user = await GoogleCalendarSvc.disconnect(req.user.userId);
    return res.status(200).json(user);
  }
}
