import { Request, Response } from "express";
import type { ObjectSchema } from "joi";
import ClientCaseSvc from "../services/client-case.service";
import ClientBillingSvc from "../services/client-billing.service";
import HttpError from "../utils/http-error";
import {
  addClientDocumentSchema,
  createClientCaseSchema,
  payForClientCaseSchema,
  presignClientDocumentSchema,
  quoteClientCaseSchema,
  sendClientMessageSchema,
  topUpClientCaseSchema,
} from "../validation/client-case.validation";

function validate<T>(schema: ObjectSchema<T>, body: unknown): T {
  const { error, value } = schema.validate(body, { stripUnknown: true });
  if (error) throw new HttpError(error.message, 400);
  return value;
}

/** The client app's case routes. requireClientAccount has already set req.organization to the
 * client's personal workspace. */
export default class ClientCaseCtrl {
  static async list(req: Request, res: Response) {
    res.status(200).json(await ClientCaseSvc.list(req.organization!));
  }

  static async get(req: Request, res: Response) {
    res.status(200).json(await ClientCaseSvc.get(req.organization!, req.params.caseId));
  }

  static async create(req: Request, res: Response) {
    const input = validate(createClientCaseSchema, req.body);
    res.status(201).json(await ClientCaseSvc.create(req.organization!, req.user.userId, input));
  }

  static async listMessages(req: Request, res: Response) {
    res.status(200).json(await ClientCaseSvc.listMessages(req.organization!, req.user.userId, req.params.caseId));
  }

  static async sendMessage(req: Request, res: Response) {
    const { text } = validate(sendClientMessageSchema, req.body);
    res.status(202).json(await ClientCaseSvc.sendMessage(req.organization!, req.user.userId, req.params.caseId, text));
  }

  static async presignDocument(req: Request, res: Response) {
    const file = validate(presignClientDocumentSchema, req.body);
    res.status(200).json(await ClientCaseSvc.presignDocument(req.organization!, req.user.userId, req.params.caseId, file));
  }

  static async addDocument(req: Request, res: Response) {
    const file = validate(addClientDocumentSchema, req.body);
    res.status(201).json(await ClientCaseSvc.addDocument(req.organization!, req.user.userId, req.params.caseId, file));
  }

  static async pricing(_req: Request, res: Response) {
    res.status(200).json(ClientBillingSvc.pricing());
  }

  static async quoteCase(req: Request, res: Response) {
    const { promoCode } = validate(quoteClientCaseSchema, req.body);
    res.status(200).json(await ClientBillingSvc.quoteCase(req.user.userId, promoCode));
  }

  static async payForCase(req: Request, res: Response) {
    const input = validate(payForClientCaseSchema, req.body);
    res.status(201).json(await ClientBillingSvc.payForCase(req.user.userId, input));
  }

  static async topUp(req: Request, res: Response) {
    const input = validate(topUpClientCaseSchema, req.body);
    res.status(201).json(await ClientCaseSvc.topUp(req.organization!, req.user.userId, req.params.caseId, input));
  }
}
