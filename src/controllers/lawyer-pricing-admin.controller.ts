import type { Request, Response } from "express";
import type { ObjectSchema } from "joi";
import LawyerPricingSvc from "../services/lawyer-pricing.service";
import HttpError from "../utils/http-error";
import { asTenantCode, type TenantCode } from "../types/tenant-code";
import { createLawyerPackSchema, updateLawyerIntroFeeSchema, updateLawyerPackSchema } from "../validation/lawyer-pricing-admin.validation";

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

/** What lawyers pay, per tenant, on the admin Settings page (LawyerPricingSvc, #598): the
 * introduction fee and the AI top-up packs. Creating a pack takes the tenant from the path; editing
 * one goes by its id, which already belongs to one tenant. */
export default class LawyerPricingAdminCtrl {
  /** GET /api/admin/settings/lawyer-pricing */
  static async get(_req: Request, res: Response) {
    res.status(200).json(await LawyerPricingSvc.listForAdmin());
  }

  /** PATCH /api/admin/settings/tenants/:code/lawyer-pricing/intro-fee */
  static async updateIntroFee(req: Request, res: Response) {
    res.status(200).json(await LawyerPricingSvc.updateIntroFee(parseTenantCode(req.params.code), validate(updateLawyerIntroFeeSchema, req.body), req.user.userId));
  }

  /** POST /api/admin/settings/tenants/:code/lawyer-pricing/packs */
  static async createPack(req: Request, res: Response) {
    res.status(201).json(await LawyerPricingSvc.createPack(parseTenantCode(req.params.code), validate(createLawyerPackSchema, req.body), req.user.userId));
  }

  /** PATCH /api/admin/settings/lawyer-pricing/packs/:id — edit, reorder, or turn on/off. */
  static async updatePack(req: Request, res: Response) {
    res.status(200).json(await LawyerPricingSvc.updatePack(req.params.id, validate(updateLawyerPackSchema, req.body), req.user.userId));
  }
}
