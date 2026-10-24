import type { Request, Response } from "express";
import type { ObjectSchema } from "joi";
import ClientPricingSvc from "../services/client-pricing.service";
import HttpError from "../utils/http-error";
import { asTenantCode, type TenantCode } from "../types/tenant-code";
import {
  createClientPackSchema,
  createClientPromoSchema,
  updateClientCasePriceSchema,
  updateClientPackSchema,
  updateClientPromoSchema,
} from "../validation/client-pricing-admin.validation";

function validate<T>(schema: ObjectSchema<T>, body: unknown): T {
  const { error, value } = schema.validate(body ?? {});
  if (error) throw new HttpError(error.message, 400);
  return value;
}

function parseTenantCode(raw: string): TenantCode {
  try {
    return asTenantCode(raw);
  } catch {
    throw new HttpError(`Unknown tenant ${raw}`, 404);
  }
}

/** The client app's per-tenant prices and promo codes on the admin Settings page (ClientPricingSvc).
 * Creating takes the tenant from the path; editing a pack or promo goes by its id, which already
 * belongs to one tenant. */
export default class ClientPricingAdminCtrl {
  /** GET /api/admin/settings/client-pricing */
  static async get(_req: Request, res: Response) {
    res.status(200).json(await ClientPricingSvc.listForAdmin());
  }

  /** PATCH /api/admin/settings/tenants/:code/client-pricing/case */
  static async updateCase(req: Request, res: Response) {
    res.status(200).json(await ClientPricingSvc.updateCase(parseTenantCode(req.params.code), validate(updateClientCasePriceSchema, req.body), req.user.userId));
  }

  /** POST /api/admin/settings/tenants/:code/client-pricing/packs */
  static async createPack(req: Request, res: Response) {
    res.status(201).json(await ClientPricingSvc.createPack(parseTenantCode(req.params.code), validate(createClientPackSchema, req.body), req.user.userId));
  }

  /** PATCH /api/admin/settings/client-pricing/packs/:id — edit, reorder, or turn on/off. */
  static async updatePack(req: Request, res: Response) {
    res.status(200).json(await ClientPricingSvc.updatePack(req.params.id, validate(updateClientPackSchema, req.body), req.user.userId));
  }

  /** POST /api/admin/settings/client-pricing/packs/:id/default */
  static async setDefaultPack(req: Request, res: Response) {
    await ClientPricingSvc.setDefaultPack(req.params.id, req.user.userId);
    res.status(204).end();
  }

  /** POST /api/admin/settings/tenants/:code/client-promos */
  static async createPromo(req: Request, res: Response) {
    res.status(201).json(await ClientPricingSvc.createPromo(parseTenantCode(req.params.code), validate(createClientPromoSchema, req.body), req.user.userId));
  }

  /** PATCH /api/admin/settings/client-promos/:id — edit, or turn off with isActive. */
  static async updatePromo(req: Request, res: Response) {
    res.status(200).json(await ClientPricingSvc.updatePromo(req.params.id, validate(updateClientPromoSchema, req.body), req.user.userId));
  }
}
