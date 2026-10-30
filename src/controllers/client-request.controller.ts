import { clientWorkspaceOf } from "../middleware/require-client-account.middleware";
import { Request, Response } from "express";
import type { ObjectSchema } from "joi";
import ClientRequestSvc from "../services/client-request.service";
import EngagementMessageSvc from "../services/engagement-message.service";
import HttpError from "../utils/http-error";
import {
  clientRequestEligibilitySchema,
  confirmClientRequestSchema,
  createClientRequestSchema,
  declineClientRequestSchema,
  endClientRequestSchema,
  feedbackClientRequestSchema,
  listClientRequestsSchema,
  listEngagementMessagesSchema,
  engagementThreadSchema,
  postEngagementMessageSchema,
} from "../validation/client-request.validation";

function validate<T>(schema: ObjectSchema<T>, input: unknown): T {
  const { error, value } = schema.validate(input, { stripUnknown: true, convert: true });
  if (error) throw new HttpError(error.message, 400);
  return value;
}

/** The client app's lawyer requests (/api/client/lawyer-requests). requireClientAccount has set
 * the request's workspace to the client's personal workspace. */
export default class ClientRequestCtrl {
  static async consent(_req: Request, res: Response) {
    res.status(200).json(ClientRequestSvc.consent());
  }

  static async eligibility(req: Request, res: Response) {
    const { caseId } = validate(clientRequestEligibilitySchema, req.query);
    res.status(200).json(await ClientRequestSvc.eligibility(clientWorkspaceOf(req), caseId));
  }

  static async create(req: Request, res: Response) {
    const input = validate(createClientRequestSchema, req.body);
    res.status(201).json(await ClientRequestSvc.create(clientWorkspaceOf(req), req.user.userId, input));
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

  static async end(req: Request, res: Response) {
    const body = validate(endClientRequestSchema, req.body ?? {});
    res.status(200).json(await ClientRequestSvc.end(req.user.userId, req.params.id, body));
  }

  /** The thread with one lawyer (#517; `?claimId=`, or the hired lawyer's), oldest first, with how
   * many of the lawyer's messages are unread. */
  static async messages(req: Request, res: Response) {
    const { claimId, ...query } = validate(listEngagementMessagesSchema, req.query);
    const thread = await EngagementMessageSvc.forClient(req.user.userId, req.params.id, claimId);
    res.status(200).json(await EngagementMessageSvc.list(thread, "CLIENT", query));
  }

  static async postMessage(req: Request, res: Response) {
    const { claimId } = validate(engagementThreadSchema, req.query);
    const body = validate(postEngagementMessageSchema, req.body ?? {});
    const thread = await EngagementMessageSvc.forClient(req.user.userId, req.params.id, claimId);
    res.status(201).json(await EngagementMessageSvc.post(thread, "CLIENT", req.user.userId, body));
  }

  static async readMessages(req: Request, res: Response) {
    const { claimId } = validate(engagementThreadSchema, req.query);
    await EngagementMessageSvc.markRead(await EngagementMessageSvc.forClient(req.user.userId, req.params.id, claimId), "CLIENT");
    res.status(204).end();
  }

  static async feedback(req: Request, res: Response) {
    const body = validate(feedbackClientRequestSchema, req.body ?? {});
    res.status(201).json(await ClientRequestSvc.feedback(req.user.userId, req.params.id, body));
  }
}
