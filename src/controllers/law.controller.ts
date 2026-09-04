import { Request, Response } from "express";
import Joi from "joi";
import LawSvc, { parseLawCategory } from "../services/law.service";
import HttpError from "../utils/http-error";
import { getTenantContext } from "../utils/tenant-context";
import { JURIS_PH_CASE_TYPES, JURIS_PH_TOPICS } from "../utils/juris-ph";

const lawSearchSchema = Joi.object({
  category: Joi.string().valid("jurisprudence", "republic-acts").required(),
  q: Joi.string().trim().min(1).max(300).required(),
  limit: Joi.number().integer().min(1).max(20).default(5),
});

const lawDocumentSchema = Joi.object({
  category: Joi.string().valid("jurisprudence", "republic-acts").required(),
  id: Joi.string().trim().min(1).max(200).required(),
});

const lawBrowseSchema = Joi.object({
  category: Joi.string().valid("jurisprudence", "republic-acts").required(),
  // jurisprudence-only; ignored (rejected) for republic-acts.
  caseType: Joi.string()
    .valid(...JURIS_PH_CASE_TYPES)
    .optional(),
  // csv, e.g. "criminal,labor"
  topics: Joi.string()
    .custom((raw: string, helpers) => {
      const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
      const bad = list.find((t) => !(JURIS_PH_TOPICS as readonly string[]).includes(t));
      if (bad) return helpers.error("any.invalid", { bad });
      return list;
    })
    .optional(),
  year: Joi.number().integer().min(1900).max(2100).optional(),
  cursor: Joi.string().max(20000).optional(),
  limit: Joi.number().integer().min(1).max(20).default(20),
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

  /**
   * GET /api/law/browse — facet browse (no free-text query) over juris.ph, 20 per page with an
   * opaque `cursor` for "load more". Same PH-tenant-only rule as search. `caseType` applies to
   * jurisprudence only; `topics` is a csv of the juris.ph topic vocabulary.
   */
  static async browse(req: Request, res: Response) {
    const { tenantCode } = getTenantContext(req);
    if (tenantCode !== "PH") {
      throw new HttpError("Philippine law browse is not available for this jurisdiction — coming soon", 501);
    }

    const { error, value } = lawBrowseSchema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const result = await LawSvc.browse({
      category: parseLawCategory(value.category),
      caseType: value.category === "jurisprudence" ? value.caseType : undefined,
      topics: value.topics,
      year: value.year,
      cursor: value.cursor,
      limit: value.limit,
    });
    return res.status(200).json(result);
  }

  /**
   * GET /api/law/document — one document by its juris id, for the detail page. Local-first
   * with detail (LawSvc.getDocument): a stored row that already has its full detail is served
   * from the DB; otherwise juris.ph's retrieve API fills it in and stores it. PH-tenant only.
   */
  static async getDocument(req: Request, res: Response) {
    const { tenantCode } = getTenantContext(req);
    if (tenantCode !== "PH") {
      throw new HttpError("Philippine law documents are not available for this jurisdiction — coming soon", 501);
    }

    const { error, value } = lawDocumentSchema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const result = await LawSvc.getDocument({
      category: parseLawCategory(value.category),
      id: value.id,
    });
    return res.status(200).json(result);
  }
}
