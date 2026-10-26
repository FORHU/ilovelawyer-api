import { clientWorkspaceOf } from "../middleware/require-client-account.middleware";
import { Request, Response } from "express";
import type { ObjectSchema } from "joi";
import ClientCaseSvc from "../services/client-case.service";
import ClientOverviewSvc from "../services/client-overview.service";
import ClientCaseOverviewSvc from "../services/client-case-overview.service";
import ClientIntakeSvc from "../services/client-intake.service";
import ClientBillingSvc from "../services/client-billing.service";
import HttpError from "../utils/http-error";
import { ALLOWED_DOCUMENT_EXTENSIONS, DOCUMENT_UPLOAD_BATCH_MAX_BYTES } from "../constants";
import {
  addClientDocumentSchema,
  createClientCaseSchema,
  payForClientCaseSchema,
  presignClientDocumentSchema,
  quoteClientCaseSchema,
  sendClientMessageSchema,
  topUpClientCaseSchema,
  updateClientCaseSchema,
} from "../validation/client-case.validation";

function validate<T>(schema: ObjectSchema<T>, body: unknown): T {
  const { error, value } = schema.validate(body, { stripUnknown: true });
  if (error) throw new HttpError(error.message, 400);
  return value;
}

/** The client app's case routes. requireClientAccount has already set the request's workspace to the
 * client's personal workspace. */
export default class ClientCaseCtrl {
  static async list(req: Request, res: Response) {
    res.status(200).json(await ClientCaseSvc.list(clientWorkspaceOf(req), req.query.archived === "true"));
  }

  /** What the app tells the client before they upload: the file types and size the API accepts. */
  static async limits(_req: Request, res: Response) {
    res.status(200).json({ upload: { extensions: ALLOWED_DOCUMENT_EXTENSIONS, maxBytes: DOCUMENT_UPLOAD_BATCH_MAX_BYTES } });
  }

  static async get(req: Request, res: Response) {
    res.status(200).json(await ClientCaseSvc.get(clientWorkspaceOf(req), req.params.caseId));
  }

  static async create(req: Request, res: Response) {
    const input = validate(createClientCaseSchema, req.body);
    res.status(201).json(await ClientCaseSvc.create(clientWorkspaceOf(req), req.user.userId, input));
  }

  static async update(req: Request, res: Response) {
    const input = validate(updateClientCaseSchema, req.body);
    res.status(200).json(await ClientCaseSvc.update(clientWorkspaceOf(req), req.user.userId, req.params.caseId, input));
  }

  static async archive(req: Request, res: Response) {
    await ClientCaseSvc.archive(clientWorkspaceOf(req), req.user.userId, req.params.caseId);
    res.status(204).end();
  }

  static async unarchive(req: Request, res: Response) {
    res.status(200).json(await ClientCaseSvc.unarchive(clientWorkspaceOf(req), req.user.userId, req.params.caseId));
  }

  static async remove(req: Request, res: Response) {
    await ClientCaseSvc.remove(clientWorkspaceOf(req), req.user.userId, req.params.caseId);
    res.status(204).end();
  }

  static async listMessages(req: Request, res: Response) {
    res.status(200).json(await ClientCaseSvc.listMessages(clientWorkspaceOf(req), req.user.userId, req.params.caseId));
  }

  static async sendMessage(req: Request, res: Response) {
    const { text, documentIds } = validate(sendClientMessageSchema, req.body);
    res.status(202).json(await ClientCaseSvc.sendMessage(clientWorkspaceOf(req), req.user.userId, req.params.caseId, text, documentIds));
  }

  static async presignDocument(req: Request, res: Response) {
    const file = validate(presignClientDocumentSchema, req.body);
    res.status(200).json(await ClientCaseSvc.presignDocument(clientWorkspaceOf(req), req.user.userId, req.params.caseId, file));
  }

  static async addDocument(req: Request, res: Response) {
    const file = validate(addClientDocumentSchema, req.body);
    res.status(201).json(await ClientCaseSvc.addDocument(clientWorkspaceOf(req), req.user.userId, req.params.caseId, file));
  }

  static async removeDocument(req: Request, res: Response) {
    await ClientCaseSvc.removeDocument(clientWorkspaceOf(req), req.user.userId, req.params.caseId, req.params.documentId);
    res.status(204).end();
  }

  static async documentUrl(req: Request, res: Response) {
    res.status(200).json(await ClientCaseSvc.documentUrl(clientWorkspaceOf(req), req.params.caseId, req.params.documentId));
  }

  static async retryDocument(req: Request, res: Response) {
    res.status(200).json(await ClientCaseSvc.retryDocument(clientWorkspaceOf(req), req.params.caseId, req.params.documentId));
  }

  static async overview(req: Request, res: Response) {
    res.status(200).json(await ClientCaseOverviewSvc.get(clientWorkspaceOf(req), req.params.caseId));
  }

  static async generateOverview(req: Request, res: Response) {
    res.status(202).json(await ClientOverviewSvc.beginQueued(clientWorkspaceOf(req), req.user.userId, req.params.caseId));
  }

  static async intake(req: Request, res: Response) {
    res.status(200).json(await ClientIntakeSvc.get(clientWorkspaceOf(req), req.params.caseId));
  }

  static async refreshIntake(req: Request, res: Response) {
    res.status(202).json(await ClientIntakeSvc.beginQueued(clientWorkspaceOf(req), req.user.userId, req.params.caseId));
  }

  static async lawyerReadiness(req: Request, res: Response) {
    res.status(200).json(await ClientCaseSvc.lawyerReadiness(clientWorkspaceOf(req), req.user.userId, req.params.caseId));
  }

  static async pricing(req: Request, res: Response) {
    res.status(200).json(await ClientBillingSvc.pricing(req.user.userId));
  }

  static async quoteCase(req: Request, res: Response) {
    const { promoCode } = validate(quoteClientCaseSchema, req.body);
    res.status(200).json(await ClientBillingSvc.quoteCase(req.user.userId, promoCode));
  }

  static async payForCase(req: Request, res: Response) {
    const input = validate(payForClientCaseSchema, req.body);
    res.status(201).json(await ClientBillingSvc.payForCase(req.user.userId, { ...input, origin: req.headers.origin }));
  }

  static async topUp(req: Request, res: Response) {
    const input = validate(topUpClientCaseSchema, req.body);
    res.status(201).json(await ClientCaseSvc.topUp(clientWorkspaceOf(req), req.user.userId, req.params.caseId, { ...input, origin: req.headers.origin }));
  }

  /** Where a payment stands; checks a pending Stripe payment with Stripe first. */
  static async paymentStatus(req: Request, res: Response) {
    res.status(200).json(await ClientBillingSvc.paymentStatus(req.user.userId, req.params.paymentId));
  }
}
