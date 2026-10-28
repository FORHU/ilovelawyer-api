import { Request, Response } from "express";
import type { ObjectSchema } from "joi";
import ClientRequestLawyerSvc, { type LawyerContext } from "../services/client-request-lawyer.service";
import EngagementMessageSvc from "../services/engagement-message.service";
import HttpError from "../utils/http-error";
import { getTenantContext } from "../utils/tenant-context";
import { aiTopUpSchema, closeClientRequestSchema, listEngagementMessagesSchema, postEngagementMessageSchema, listLawyerClientRequestsSchema, quoteClientRequestSchema, releaseClientRequestSchema } from "../validation/client-request.validation";

function validate<T>(schema: ObjectSchema<T>, input: unknown): T {
  const { error, value } = schema.validate(input, { stripUnknown: true, convert: true });
  if (error) throw new HttpError(error.message, 400);
  return value;
}

function lawyerOf(req: Request): LawyerContext {
  const { userId, organizationId, tenantCode } = getTenantContext(req);
  return { userId, organizationId, tenantCode };
}

/** The lawyer app's client requests (/api/client-requests): the inbox, claim and pass (#511), and
 * the conflict check, release and quote (#512).
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

  static async parties(req: Request, res: Response) {
    res.status(200).json(await ClientRequestLawyerSvc.parties(lawyerOf(req), req.params.id));
  }

  static async intakePackage(req: Request, res: Response) {
    res.status(200).json(await ClientRequestLawyerSvc.intakePackage(lawyerOf(req), req.params.id));
  }

  static async release(req: Request, res: Response) {
    const body = validate(releaseClientRequestSchema, req.body ?? {});
    res.status(200).json(await ClientRequestLawyerSvc.release(lawyerOf(req), req.params.id, body));
  }

  static async quote(req: Request, res: Response) {
    const body = validate(quoteClientRequestSchema, req.body ?? {});
    res.status(200).json(await ClientRequestLawyerSvc.quote(lawyerOf(req), req.params.id, body));
  }

  static async retryCharge(req: Request, res: Response) {
    res.status(200).json(await ClientRequestLawyerSvc.retryCharge(lawyerOf(req), req.params.id));
  }

  static async copy(req: Request, res: Response) {
    res.status(202).json(await ClientRequestLawyerSvc.copy(lawyerOf(req), req.params.id));
  }

  static async aiBudget(req: Request, res: Response) {
    res.status(200).json(await ClientRequestLawyerSvc.aiBudget(lawyerOf(req), req.params.id));
  }

  static async topUp(req: Request, res: Response) {
    const body = validate(aiTopUpSchema, req.body ?? {});
    res.status(202).json(await ClientRequestLawyerSvc.topUp(lawyerOf(req), req.params.id, body));
  }

  /** The engagement thread (#517), oldest first, with how many of the client's messages are unread. */
  static async messages(req: Request, res: Response) {
    const query = validate(listEngagementMessagesSchema, req.query);
    const thread = await EngagementMessageSvc.forLawyer(lawyerOf(req).userId, req.params.id);
    res.status(200).json(await EngagementMessageSvc.list(thread, "LAWYER", query));
  }

  static async postMessage(req: Request, res: Response) {
    const body = validate(postEngagementMessageSchema, req.body ?? {});
    const thread = await EngagementMessageSvc.forLawyer(lawyerOf(req).userId, req.params.id);
    res.status(201).json(await EngagementMessageSvc.post(thread, "LAWYER", lawyerOf(req).userId, { body: body.body }));
  }

  static async readMessages(req: Request, res: Response) {
    await EngagementMessageSvc.markRead(await EngagementMessageSvc.forLawyer(lawyerOf(req).userId, req.params.id), "LAWYER");
    res.status(204).end();
  }

  static async close(req: Request, res: Response) {
    const body = validate(closeClientRequestSchema, req.body ?? {});
    res.status(200).json(await ClientRequestLawyerSvc.close(lawyerOf(req), req.params.id, body));
  }

  static async pass(req: Request, res: Response) {
    await ClientRequestLawyerSvc.pass(lawyerOf(req), req.params.id);
    res.status(204).end();
  }
}
