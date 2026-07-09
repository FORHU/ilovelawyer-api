import { Request, Response } from "express";
import Joi from "joi";
import LegalRagSvc from "../services/legal-rag.service";
import HttpError from "../utils/http-error";

export default class LegalRagCtrl {
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
    const result = await LegalRagSvc.list(page, limit, category, year, search);

    return res.status(200).json(result);
  }

  static async getById(req: Request, res: Response) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError("Invalid case law document ID", 400);
    }

    const doc = await LegalRagSvc.getById(id);
    return res.status(200).json(doc);
  }

  static async getSourcePageDoc(req: Request, res: Response) {
    const { itemId } = req.params;
    const titleHint = typeof req.query.title === "string" ? req.query.title.trim() : undefined;
    const doc = await LegalRagSvc.getSourcePageDoc(itemId, titleHint);
    return res.status(200).json(doc);
  }
}
