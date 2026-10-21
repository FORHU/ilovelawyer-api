import { Request, Response } from "express";
import type { ObjectSchema } from "joi";
import ClientRequestSvc from "../services/client-request.service";
import HttpError from "../utils/http-error";
import {
  clientRequestEligibilitySchema,
  confirmClientRequestSchema,
  createClientRequestSchema,
  declineClientRequestSchema,
  listClientRequestsSchema,
} from "../validation/client-request.validation";

function validate<T>(schema: ObjectSchema<T>, input: unknown): T {
  const { error, value } = schema.validate(input, { stripUnknown: true, convert: true });
  if (error) throw new HttpError(error.message, 400);
  return value;
}

/** The client app's lawyer requests (/api/client/lawyer-requests). requireClientAccount has set
 * req.organization to the client's personal workspace. */
export default class ClientRequestCtrl {
  static async consent(_req: Request, res: Response) {
    res.status(200).json(ClientRequestSvc.consent());
  }

  static async eligibility(req: Request, res: Response) {
    const { caseId } = validate(clientRequestEligibilitySchema, req.query);
    res.status(200).json(await ClientRequestSvc.eligibility(req.organization!, caseId));
  }

  static async create(req: Request, res: Response) {
    const input = validate(createClientRequestSchema, req.body);
    res.status(201).json(await ClientRequestSvc.create(req.organization!, req.user.userId, input));
  }

  static async list(req: Request, res: Response) {
    const query = validate(listClientRequestsSchema, req.query);
    res.status(200).json(await ClientRequestSvc.list(req.user.userId, query));
  }

  static async get(req: Request, res: Response) {
    res.status(200).json(await ClientRequestSvc.get(req.user.userId, req.params.id));
  }

  static async confirm(req: Request, res: Response) {
    const body = validate(confirmClientRequestSchema, req.body ?? {});
    res.status(200).json(await ClientRequestSvc.confirm(req.user.userId, req.params.id, body));
  }

  static async decline(req: Request, res: Response) {
    const body = validate(declineClientRequestSchema, req.body ?? {});
    res.status(200).json(await ClientRequestSvc.decline(req.user.userId, req.params.id, body));
  }

  static async withdraw(req: Request, res: Response) {
    res.status(200).json(await ClientRequestSvc.withdraw(req.user.userId, req.params.id));
  }
}
