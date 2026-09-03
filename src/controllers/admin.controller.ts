import { Request, Response } from "express";
import Joi from "joi";
import AdminSvc from "../services/admin.service";
import LawSvc, { parseLawCategory } from "../services/law.service";
import HttpError from "../utils/http-error";

const listUsersSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  sortBy: Joi.string().valid("name", "email", "createdAt", "lastLoginAt").default("createdAt"),
  sortDir: Joi.string().valid("asc", "desc").default("desc"),
  q: Joi.string().trim().max(200).optional(),
});

const lawSearchSchema = Joi.object({
  category: Joi.string().valid("jurisprudence", "republic-acts").required(),
  q: Joi.string().trim().min(1).max(300).required(),
  limit: Joi.number().integer().min(1).max(20).default(5),
});

const listLawsSchema = Joi.object({
  category: Joi.string().valid("jurisprudence", "republic-acts").optional(),
  q: Joi.string().trim().max(300).optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  sortBy: Joi.string().valid("year", "createdAt").default("createdAt"),
  sortDir: Joi.string().valid("asc", "desc").default("desc"),
});

export default class AdminCtrl {
  static async listUsers(req: Request, res: Response) {
    const { error, value } = listUsersSchema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const { page, limit, sortBy, sortDir, q } = value;
    const { data, total } = await AdminSvc.listUsers({ page, limit, sortBy, sortDir, q });

    return res.status(200).json({
      data,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
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

  static async reactivateUser(req: Request, res: Response) {
    const user = await AdminSvc.reactivate(req.params.id);
    return res.status(200).json(user);
  }

  static async blockUser(req: Request, res: Response) {
    const user = await AdminSvc.block(req.params.id);
    return res.status(200).json(user);
  }

  static async unblockUser(req: Request, res: Response) {
    const user = await AdminSvc.unblock(req.params.id);
    return res.status(200).json(user);
  }

  /** GET /api/admin/law/search — proxy juris.ph, store any new hits, return them annotated. */
  static async searchLaw(req: Request, res: Response) {
    const { error, value } = lawSearchSchema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const result = await LawSvc.search({
      category: parseLawCategory(value.category),
      q: value.q,
      limit: value.limit,
    });
    return res.status(200).json(result);
  }

  /** GET /api/admin/law — the laws already saved in our own database (no juris.ph call). */
  static async listLaw(req: Request, res: Response) {
    const { error, value } = listLawsSchema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const result = await LawSvc.list({
      category: value.category ? parseLawCategory(value.category) : undefined,
      q: value.q,
      page: value.page,
      limit: value.limit,
      sortBy: value.sortBy,
      sortDir: value.sortDir,
    });
    return res.status(200).json(result);
  }
}
