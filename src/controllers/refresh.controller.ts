import { Request, Response } from "express";
import Joi from "joi";
import RefreshSvc from "../services/refresh.service";
import HttpError from "../utils/http-error";

export default class RefreshCtrl {
  static async refresh(req: Request, res: Response) {
    const { refreshToken } = req.body;

    const schema = Joi.object({
      refreshToken: Joi.string().required(),
    });

    const { error } = schema.validate({ refreshToken });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const result = await RefreshSvc.refresh(refreshToken);

    return res.status(200).json(result);
  }
}
