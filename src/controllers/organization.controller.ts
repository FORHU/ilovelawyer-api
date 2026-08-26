import { Request, Response } from "express";
import Joi from "joi";
import { OrganizationRole } from "@prisma/client";
import OrganizationSvc from "../services/organization.service";
import HttpError from "../utils/http-error";
import { resolveJurisdictionFromRequest } from "../utils/jurisdiction-host";

const slugSchema = Joi.string()
  .trim()
  .lowercase()
  .pattern(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .min(2)
  .max(60);

const roleSchema = Joi.string().valid(...Object.values(OrganizationRole));

export default class OrganizationCtrl {
  static async create(req: Request, res: Response) {
    const schema = Joi.object({
      name: Joi.string().trim().min(1).max(120).required(),
      packageSku: Joi.string().valid("SOLO", "PROFESSIONAL", "ENTERPRISE").optional(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    // Jurisdiction is never accepted from the client — the Joi schema above doesn't even
    // allow a `jurisdiction` key, so a body trying to smuggle one in already 400s above.
    // The authoritative jurisdiction comes from which frontend domain (ph./uk.) this signup
    // request actually originated from.
    const jurisdiction = resolveJurisdictionFromRequest(req);
    if (!jurisdiction) throw new HttpError("Unable to determine jurisdiction from request origin", 400);

    const result = await OrganizationSvc.create(req.user.userId, value.name, value.packageSku, jurisdiction);
    return res.status(201).json(result);
  }

  static async list(req: Request, res: Response) {
    const result = await OrganizationSvc.listForUser(req.user.userId);
    return res.status(200).json(result);
  }

  static async getById(req: Request, res: Response) {
    const result = await OrganizationSvc.getById(req.params.id, req.user.userId);
    return res.status(200).json(result);
  }

  static async update(req: Request, res: Response) {
    const schema = Joi.object({
      name: Joi.string().trim().min(1).max(120).optional(),
      slug: slugSchema.optional(),
    }).min(1);

    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const result = await OrganizationSvc.update(req.params.id, value);
    return res.status(200).json(result);
  }

  static async listMembers(req: Request, res: Response) {
    const result = await OrganizationSvc.listMembers(req.params.id);
    return res.status(200).json(result);
  }

  static async inviteMember(req: Request, res: Response) {
    const schema = Joi.object({
      email: Joi.string().trim().email().required(),
      role: roleSchema.default(OrganizationRole.MEMBER),
    });

    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const result = await OrganizationSvc.inviteMember(
      req.params.id,
      req.organization!.role,
      req.user.userId,
      value.email,
      value.role,
    );
    return res.status(201).json(result);
  }

  static async getMyInvite(req: Request, res: Response) {
    const result = await OrganizationSvc.getPendingInviteForUser(req.user.userId);
    return res.status(200).json(result);
  }

  static async acceptInvite(req: Request, res: Response) {
    const result = await OrganizationSvc.acceptInvite(req.params.id, req.user.userId);
    return res.status(200).json(result);
  }

  static async declineInvite(req: Request, res: Response) {
    await OrganizationSvc.declineInvite(req.params.id, req.user.userId);
    return res.status(204).send();
  }

  static async changeMemberRole(req: Request, res: Response) {
    const schema = Joi.object({ role: roleSchema.required() });

    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const result = await OrganizationSvc.changeMemberRole(req.params.id, req.organization!.role, req.params.userId, value.role);
    return res.status(200).json(result);
  }

  static async removeMember(req: Request, res: Response) {
    await OrganizationSvc.removeMember(req.params.id, req.organization!.role, req.user.userId, req.params.userId);
    return res.status(204).send();
  }

  static async leave(req: Request, res: Response) {
    await OrganizationSvc.leave(req.params.id, req.user.userId);
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
