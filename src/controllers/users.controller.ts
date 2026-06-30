import { Request, Response } from "express";
import UsersSvc from "../services/users.service";

export default class UsersCtrl {
  static async me(req: Request, res: Response) {
    const user = await UsersSvc.getMe(req.user.userId);
    return res.status(200).json(user);
  }
}
