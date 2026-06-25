import { Request, Response } from "express";
import Joi from "joi";
import LegalRagSvc from "../services/legalRag.service";
import HttpError from "../utils/http-error";

export default class LegalRagCtrl {
  static async listDocuments(req: Request, res: Response) {
    const { q, category, subcategory, year, yearFrom, yearTo, libraries, limit, offset } = req.query;

    const schema = Joi.object({
      q: Joi.string().optional(),
      category: Joi.string().optional(),
      subcategory: Joi.string().optional(),
      year: Joi.number().integer().optional(),
      yearFrom: Joi.number().integer().optional(),
      yearTo: Joi.number().integer().optional(),
      libraries: Joi.string().optional(),
      limit: Joi.number().integer().min(1).max(100).optional(),
      offset: Joi.number().integer().min(0).optional(),
    });

    const { error, value } = schema.validate({ q, category, subcategory, year, yearFrom, yearTo, libraries, limit, offset });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const { rows, total } = await LegalRagSvc.listDocuments({
      keyword: value.q,
      category: value.category,
      subcategory: value.subcategory,
      year: value.year,
      yearFrom: value.yearFrom,
      yearTo: value.yearTo,
      libraries: value.libraries ? String(value.libraries).split(",") : undefined,
      limit: value.limit ?? 20,
      offset: value.offset ?? 0,
    });

    return res.status(200).json({ documents: rows, total });
  }
}
