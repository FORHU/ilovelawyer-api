import { Request, Response } from "express";
import Joi from "joi";
import OrganizationSvc from "../services/organization.service";
import HttpError from "../utils/http-error";

export default class OrganizationCtrl {
  static async create(req: Request, res: Response) {
    const schema = Joi.object({
      name: Joi.string().trim().min(1).required(),
      packageSku: Joi.string().valid("SOLO", "PROFESSIONAL", "ENTERPRISE").optional(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await OrganizationSvc.create(req.user.userId, value.name, value.packageSku);
    return res.status(201).json(result);
  }

  static async list(req: Request, res: Response) {
    const result = await OrganizationSvc.list(req.user.userId);
    return res.status(200).json(result);
  }

  static async getById(req: Request, res: Response) {
    const result = await OrganizationSvc.getById(req.params.id, req.user.userId);
    return res.status(200).json(result);
  }

  static async addMember(req: Request, res: Response) {
    const schema = Joi.object({
      userId: Joi.string().required(),
      role: Joi.string().valid("OWNER", "PARTNER", "ASSOCIATE", "PARALEGAL", "MEMBER").required(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await OrganizationSvc.addMember(req.params.id, req.user.userId, value.userId, value.role);
    return res.status(201).json(result);
  }

  static async removeMember(req: Request, res: Response) {
    await OrganizationSvc.removeMember(req.params.id, req.user.userId, req.params.userId);
    return res.status(204).send();
  }

  static async attachCase(req: Request, res: Response) {
    const schema = Joi.object({ caseId: Joi.string().required() });
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await OrganizationSvc.attachCase(req.params.id, value.caseId, req.user.userId);
    return res.status(200).json(result);
  }
}
