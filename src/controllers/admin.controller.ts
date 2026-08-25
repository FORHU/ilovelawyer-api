import { Request, Response } from "express";
import Joi from "joi";
import AdminSvc from "../services/admin.service";
import HttpError from "../utils/http-error";

export default class AdminCtrl {
  static async listUsers(_req: Request, res: Response) {
    const users = await AdminSvc.listUsers();
    return res.status(200).json(users);
  }

  static async approveUser(req: Request, res: Response) {
    const user = await AdminSvc.approve(req.params.id);
    return res.status(200).json(user);
  }

  static async denyUser(req: Request, res: Response) {
    const schema = Joi.object({ reason: Joi.string().trim().max(500).allow("").optional() });
    const { error, value } = schema.validate(req.body ?? {});
    if (error) throw new HttpError(error.message, 400);

    const user = await AdminSvc.deny(req.params.id, value.reason || undefined);
    return res.status(200).json(user);
  }
}
