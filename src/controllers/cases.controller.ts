import { Request, Response } from "express";
import Joi from "joi";
import CasesSvc from "../services/cases.service";
import HttpError from "../utils/http-error";

export default class CasesCtrl {
  static async list(req: Request, res: Response) {
    const schema = Joi.object({
      page: Joi.number().integer().min(1).default(1),
      limit: Joi.number().integer().min(1).max(100).default(20),
      category: Joi.string().optional(),
      year: Joi.number().integer().optional(),
      search: Joi.string().optional(),
    });

    const { error, value } = schema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const { page, limit, category, year, search } = value;
    const result = await CasesSvc.list(page, limit, category, year, search);

    return res.status(200).json(result);
  }

  static async getById(req: Request, res: Response) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError("Invalid case ID", 400);
    }

    const doc = await CasesSvc.getById(id);
    return res.status(200).json(doc);
  }
}
