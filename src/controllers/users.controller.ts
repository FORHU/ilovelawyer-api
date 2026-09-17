import { Request, Response } from "express";
import UsersSvc from "../services/users.service";
import HttpError from "../utils/http-error";
import { updateMeSchema, changePasswordSchema } from "../validation/users.validation";

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
}
