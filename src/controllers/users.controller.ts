import { Request, Response } from "express";
import Joi from "joi";
import UsersSvc from "../services/users.service";
import HttpError from "../utils/http-error";

export default class UsersCtrl {
  static async me(req: Request, res: Response) {
    const user = await UsersSvc.getMe(req.user.userId);
    return res.status(200).json(user);
  }

  static async updateMe(req: Request, res: Response) {
    const { name, username } = req.body;

    const schema = Joi.object({
      name: Joi.string().trim().min(1).max(100).optional(),
      username: Joi.string()
        .trim()
        .min(3)
        .max(30)
        .pattern(/^[a-zA-Z0-9._]+$/)
        .optional(),
    }).min(1);

    const { error, value } = schema.validate({ name, username });
    if (error) throw new HttpError(error.message, 400);

    const user = await UsersSvc.updateMe(req.user.userId, value);
    return res.status(200).json(user);
  }

  static async deactivateMe(req: Request, res: Response) {
    const user = await UsersSvc.deactivateMe(req.user.userId);
    return res.status(200).json(user);
  }

  static async deleteMe(req: Request, res: Response) {
    await UsersSvc.deleteMe(req.user.userId);
    return res.status(204).send();
  }
}
