import { Request, Response } from "express";
import JurisdictionModuleSvc from "../services/jurisdiction-module.service";
import IntegrationSvc from "../services/integration.service";
import HttpError from "../utils/http-error";
import { setJurisdictionEnabledSchema, createIntegrationSchema, connectIntegrationSchema } from "../validation/jurisdiction.validation";

export default class JurisdictionCtrl {
  static async list(_req: Request, res: Response) {
    const result = await JurisdictionModuleSvc.list();
    return res.status(200).json(result);
  }

  static async setEnabled(req: Request, res: Response) {
    const { error, value } = setJurisdictionEnabledSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await JurisdictionModuleSvc.setEnabled(req.params.code, value.enabled);
    return res.status(200).json(result);
  }
}

export class IntegrationCtrl {
  static async list(req: Request, res: Response) {
    const organizationId = typeof req.query.organizationId === "string" ? req.query.organizationId : undefined;
    const result = await IntegrationSvc.list(req.user.userId, organizationId);
    return res.status(200).json(result);
  }

  static async create(req: Request, res: Response) {
    const { error, value } = createIntegrationSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await IntegrationSvc.create(req.user.userId, value);
    return res.status(201).json(result);
  }

  static async connect(req: Request, res: Response) {
    const { error, value } = connectIntegrationSchema.validate(req.body ?? {});
    if (error) throw new HttpError(error.message, 400);
    const result = await IntegrationSvc.connect(req.params.id, req.user.userId, value.configJson);
    return res.status(200).json(result);
  }

  static async disconnect(req: Request, res: Response) {
    const result = await IntegrationSvc.disconnect(req.params.id, req.user.userId);
    return res.status(200).json(result);
  }
}
