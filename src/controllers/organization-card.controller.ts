import { firmIdOf } from "../utils/workspace";
import { Request, Response } from "express";
import Joi from "joi";
import OrganizationCardSvc from "../services/organization-card.service";
import OrganizationChargeSvc from "../services/organization-charge.service";
import { CHARGE_KINDS } from "../types/client-handoff";
import HttpError from "../utils/http-error";

const getCardSchema = Joi.object({ setupSessionId: Joi.string().trim().max(255).optional() });
const setupSessionSchema = Joi.object({ returnUrl: Joi.string().trim().max(2048).required() });
const feesSchema = Joi.object({
  kind: Joi.string()
    .valid(...CHARGE_KINDS)
    .optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

function validate<T>(schema: Joi.ObjectSchema, input: unknown): T {
  const { error, value } = schema.validate(input ?? {});
  if (error) throw new HttpError(error.message, 400);
  return value as T;
}

/** The organization's card on file (ilovelawyer-api#505) and fee history (#513). OWNER/ADMIN only
 * (organization.route.ts). */
export default class OrganizationCardCtrl {
  /** GET /api/organizations/:id/billing/card[?setupSessionId=] — the card, or null. */
  static async get(req: Request, res: Response) {
    const { setupSessionId } = validate<{ setupSessionId?: string }>(getCardSchema, req.query);
    return res.status(200).json(await OrganizationCardSvc.get({ organizationId: firmIdOf(req) }, setupSessionId));
  }

  /** GET /api/organizations/:id/billing/fees[?kind=&page=&limit=] — the fee history (#513). */
  static async fees(req: Request, res: Response) {
    const query = validate<{ kind?: (typeof CHARGE_KINDS)[number]; page: number; limit: number }>(feesSchema, req.query);
    return res.status(200).json(await OrganizationChargeSvc.listForOrganization(firmIdOf(req), query));
  }

  /** POST /api/organizations/:id/billing/card/setup-session — body { returnUrl }. */
  static async startSetup(req: Request, res: Response) {
    const { returnUrl } = validate<{ returnUrl: string }>(setupSessionSchema, req.body);
    return res.status(200).json(await OrganizationCardSvc.startSetup({ organizationId: firmIdOf(req) }, req.user.userId, returnUrl));
  }

  /** GET /api/users/me/billing/card[?setupSessionId=] — a solo lawyer's own card, or null. They
   * have no organization to hold one (docs/adr/0022). */
  static async getOwn(req: Request, res: Response) {
    const { setupSessionId } = validate<{ setupSessionId?: string }>(getCardSchema, req.query);
    return res.status(200).json(await OrganizationCardSvc.get({ userId: req.user.userId }, setupSessionId));
  }

  /** GET /api/users/me/billing/fees[?kind=&page=&limit=] — a solo lawyer's own fee history. */
  static async ownFees(req: Request, res: Response) {
    const query = validate<{ kind?: (typeof CHARGE_KINDS)[number]; page: number; limit: number }>(feesSchema, req.query);
    return res.status(200).json(await OrganizationChargeSvc.listForLawyer(req.user.userId, query));
  }

  /** POST /api/users/me/billing/card/setup-session — body { returnUrl }: a solo lawyer's own card. */
  static async startOwnSetup(req: Request, res: Response) {
    const { returnUrl } = validate<{ returnUrl: string }>(setupSessionSchema, req.body);
    return res.status(200).json(await OrganizationCardSvc.startSetup({ userId: req.user.userId }, req.user.userId, returnUrl));
  }
}
