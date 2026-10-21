import { Request, Response } from "express";
import type { ObjectSchema } from "joi";
import ClientRequestLawyerSvc, { type LawyerContext } from "../services/client-request-lawyer.service";
import HttpError from "../utils/http-error";
import { getTenantContext } from "../utils/tenant-context";
import { listLawyerClientRequestsSchema } from "../validation/client-request.validation";

function validate<T>(schema: ObjectSchema<T>, input: unknown): T {
  const { error, value } = schema.validate(input, { stripUnknown: true, convert: true });
  if (error) throw new HttpError(error.message, 400);
  return value;
}

function lawyerOf(req: Request): LawyerContext {
  const { userId, organizationId, tenantCode } = getTenantContext(req);
  return { userId, organizationId, tenantCode };
}

/** The lawyer app's client requests (/api/client-requests): the inbox, claim and pass (#511).
 * resolveOrganization has checked the lawyer belongs to the X-Organization-Id organization. */
export default class ClientRequestLawyerCtrl {
  static async list(req: Request, res: Response) {
    const query = validate(listLawyerClientRequestsSchema, req.query);
    res.status(200).json(await ClientRequestLawyerSvc.list(lawyerOf(req), query));
  }

  static async get(req: Request, res: Response) {
    res.status(200).json(await ClientRequestLawyerSvc.get(lawyerOf(req), req.params.id));
  }

  static async claim(req: Request, res: Response) {
    res.status(200).json(await ClientRequestLawyerSvc.claim(lawyerOf(req), req.params.id));
  }

  static async pass(req: Request, res: Response) {
    await ClientRequestLawyerSvc.pass(lawyerOf(req), req.params.id);
    res.status(204).end();
  }
}
