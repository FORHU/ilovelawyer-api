import { Request, Response } from "express";
import Joi from "joi";
import OrganizationCardSvc from "../services/organization-card.service";
import HttpError from "../utils/http-error";

const getCardSchema = Joi.object({ setupSessionId: Joi.string().trim().max(255).optional() });
const setupSessionSchema = Joi.object({ returnUrl: Joi.string().trim().max(2048).required() });

function validate<T>(schema: Joi.ObjectSchema, input: unknown): T {
  const { error, value } = schema.validate(input ?? {});
  if (error) throw new HttpError(error.message, 400);
  return value as T;
}

/** The organization's card on file (ilovelawyer-api#505). OWNER/ADMIN only (organization.route.ts). */
export default class OrganizationCardCtrl {
  /** GET /api/organizations/:id/billing/card[?setupSessionId=] — the card, or null. */
  static async get(req: Request, res: Response) {
    const { setupSessionId } = validate<{ setupSessionId?: string }>(getCardSchema, req.query);
    return res.status(200).json(await OrganizationCardSvc.get(req.organization!.id, setupSessionId));
  }

  /** POST /api/organizations/:id/billing/card/setup-session — body { returnUrl }. */
  static async startSetup(req: Request, res: Response) {
    const { returnUrl } = validate<{ returnUrl: string }>(setupSessionSchema, req.body);
    return res.status(200).json(await OrganizationCardSvc.startSetup(req.organization!.id, req.user.userId, returnUrl));
  }
}
