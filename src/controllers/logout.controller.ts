import { Request, Response } from "express";
import Joi from "joi";
import LogoutSvc from "../services/logout.service";
import HttpError from "../utils/http-error";

export default class LogoutCtrl {
  static async logout(req: Request, res: Response) {
    const { refreshToken } = req.body;

    const schema = Joi.object({
      refreshToken: Joi.string().required(),
    });

    const { error } = schema.validate({ refreshToken });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    await LogoutSvc.logout(refreshToken);

    return res.status(200).json({ message: "Logged out successfully" });
  }
}
