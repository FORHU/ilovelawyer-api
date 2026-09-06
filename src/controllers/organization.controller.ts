import { Request, Response } from "express";
import OrganizationSvc from "../services/organization.service";
import HttpError from "../utils/http-error";
import { resolveTenantCodeFromRequest } from "../utils/tenant-host";
import {
  createOrganizationSchema,
  updateOrganizationSchema,
  inviteMemberSchema,
  changeMemberRoleSchema,
  attachCaseToOrganizationSchema,
} from "../validation/organization.validation";

export default class OrganizationCtrl {
  static async create(req: Request, res: Response) {
    const { error, value } = createOrganizationSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    // Tenant is never accepted from the client — the Joi schema above doesn't even
    // allow a `tenantCode`/`jurisdiction` key, so a body trying to smuggle one in already
    // 400s above. The authoritative Tenant comes from which frontend domain (ph./uk.) this
    // signup request actually originated from.
    const tenantCode = resolveTenantCodeFromRequest(req);
    if (!tenantCode) throw new HttpError("Unable to determine tenant from request origin", 400);

    const result = await OrganizationSvc.create(req.user.userId, value.name, value.packageSku, tenantCode);
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
    const { error, value } = updateOrganizationSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const result = await OrganizationSvc.update(req.params.id, value);
    return res.status(200).json(result);
  }

  static async listMembers(req: Request, res: Response) {
    const result = await OrganizationSvc.listMembers(req.params.id);
    return res.status(200).json(result);
  }

  static async inviteMember(req: Request, res: Response) {
    const { error, value } = inviteMemberSchema.validate(req.body);
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
    const { error, value } = changeMemberRoleSchema.validate(req.body);
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
    const { error, value } = attachCaseToOrganizationSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await OrganizationSvc.attachCase(req.params.id, value.caseId, req.user.userId);
    return res.status(200).json(result);
  }
}
