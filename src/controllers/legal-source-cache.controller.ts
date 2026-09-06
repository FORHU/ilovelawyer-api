import { Request, Response } from "express";
import LegalSourceCacheSvc from "../services/legal-source-cache.service";
import HttpError from "../utils/http-error";
import { getTenantContext } from "../utils/tenant-context";
import { analyzeLegalSourceSchema } from "../validation/legal-source-cache.validation";

export default class LegalSourceCacheCtrl {
  static async analyze(req: Request, res: Response) {
    const { error, value } = analyzeLegalSourceSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const { tenantCode } = getTenantContext(req);
    const result = await LegalSourceCacheSvc.analyze(value.keyword, tenantCode);
    return res.status(200).json(result);
  }
}
