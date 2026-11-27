import { Request, Response } from "express";
import type { ObjectSchema } from "joi";
import CaseLawyerInviteSvc from "../services/case-lawyer-invite.service";
import HttpError from "../utils/http-error";
import { caseLawyerInviteCaseSchema, createEmailInviteSchema } from "../validation/case-lawyer-invite.validation";

function validate<T>(schema: ObjectSchema<T>, input: unknown): T {
  const { error, value } = schema.validate(input, { stripUnknown: true, convert: true });
  if (error) throw new HttpError(error.message, 400);
  return value;
}

/** The client app's own-lawyer invites (/api/client/lawyer-invites), plus the public signup lookup
 * (/api/case-lawyer-invites/:token). Thin: every ownership and status check is CaseLawyerInviteSvc's. */
export default class CaseLawyerInviteCtrl {
  static async getCurrent(req: Request, res: Response) {
    const { caseId } = validate(caseLawyerInviteCaseSchema, req.query);
    res.status(200).json(await CaseLawyerInviteSvc.getCurrentForCase(req.user.userId, caseId));
  }

  static async createLink(req: Request, res: Response) {
    const { caseId } = validate(caseLawyerInviteCaseSchema, req.body);
    res.status(201).json(await CaseLawyerInviteSvc.createLinkInvite(req.user.userId, caseId));
  }

  static async createEmail(req: Request, res: Response) {
    const { caseId, email } = validate(createEmailInviteSchema, req.body);
    res.status(201).json(await CaseLawyerInviteSvc.createEmailInvite(req.user.userId, caseId, email));
  }

  static async revoke(req: Request, res: Response) {
    const { caseId } = validate(caseLawyerInviteCaseSchema, req.body);
    await CaseLawyerInviteSvc.revoke(req.user.userId, caseId);
    res.status(204).end();
  }

  /** GET /api/case-lawyer-invites/:token: public, no auth — the signup page's own lookup. */
  static async lookup(req: Request, res: Response) {
    res.status(200).json(await CaseLawyerInviteSvc.lookupForSignup(req.params.token));
  }
}
