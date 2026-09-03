import { Request, Response } from "express";
import Joi from "joi";
import LawSvc, { parseLawCategory } from "../services/law.service";
import HttpError from "../utils/http-error";
import { getTenantContext } from "../utils/tenant-context";

const lawSearchSchema = Joi.object({
  category: Joi.string().valid("jurisprudence", "republic-acts").required(),
  q: Joi.string().trim().min(1).max(300).required(),
  limit: Joi.number().integer().min(1).max(20).default(5),
});

export default class LawCtrl {
  /**
   * GET /api/law/search — the app-facing entry point to the same local-first search the
   * admin panel uses (LawSvc.search: stored rows first, juris.ph on a miss, write-through).
   * The admin route is ADMIN-only; this one is any authenticated org member.
   *
   * juris.ph only covers Philippine law, so this is PH-tenant only: every other tenantCode
   * (UK today, anything unmapped) gets a 501 "coming soon" rather than PH data. The frontend
   * gates the UI the same way (config/tenant-codes) and normally never calls this for a
   * non-PH org — the check here is defense-in-depth, matching legal-knowledge.registry.ts.
   */
  static async search(req: Request, res: Response) {
    const { tenantCode } = getTenantContext(req);
    if (tenantCode !== "PH") {
      throw new HttpError("Philippine law search is not available for this jurisdiction — coming soon", 501);
    }

    const { error, value } = lawSearchSchema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const result = await LawSvc.search({
      category: parseLawCategory(value.category),
      q: value.q,
      limit: value.limit,
    });
    return res.status(200).json(result);
  }
}
