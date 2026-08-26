import { Request, Response } from "express";
import Joi from "joi";
import LegalSourceCacheSvc from "../services/legal-source-cache.service";
import HttpError from "../utils/http-error";
import { getTenantContext } from "../utils/tenant-context";

export default class LegalSourceCacheCtrl {
  static async analyze(req: Request, res: Response) {
    const { error, value } = Joi.object({ keyword: Joi.string().required() }).validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const { jurisdiction } = getTenantContext(req);
    const result = await LegalSourceCacheSvc.analyze(value.keyword, jurisdiction);
    return res.status(200).json(result);
  }
}
