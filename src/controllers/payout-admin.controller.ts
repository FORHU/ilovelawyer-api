import { Request, Response } from "express";
import Joi from "joi";
import PayoutSettingsSvc from "../services/payout-settings.service";
import QuotationPaymentSvc from "../services/quotation-payment.service";
import WalletSvc from "../services/wallet.service";
import { QUOTATION_PAYMENT_STATUSES, type QuotationPaymentStatus } from "../types/client-handoff";
import { asTenantCode, type TenantCode } from "../types/tenant-code";
import HttpError from "../utils/http-error";

const settingsSchema = Joi.object({
  platformFeeBps: Joi.number().integer().optional(),
  minPlatformFeeMinor: Joi.number().integer().optional(),
  earningsHoldDays: Joi.number().integer().optional(),
  minWithdrawalMinor: Joi.number().integer().optional(),
}).min(1);
const paymentsSchema = Joi.object({
  status: Joi.string()
    .valid(...QUOTATION_PAYMENT_STATUSES)
    .optional(),
  all: Joi.boolean().default(false),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});
const pageSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});
const refundSchema = Joi.object({
  /** Left out: everything not yet refunded, the platform fee included. */
  amount: Joi.object({
    amountMinor: Joi.number().integer().min(1).required(),
    currency: Joi.string().valid("GBP").required(),
  }).optional(),
  reason: Joi.string().trim().min(1).max(500).required(),
});

function validate<T>(schema: Joi.ObjectSchema, input: unknown): T {
  const { error, value } = schema.validate(input ?? {}, { stripUnknown: true, convert: true });
  if (error) throw new HttpError(error.message, 400);
  return value as T;
}

function parseTenantCode(raw: string): TenantCode {
  try {
    return asTenantCode(raw);
  } catch {
    throw new HttpError(`Unknown tenant ${raw}`, 404);
  }
}

/** Quotation payments in the admin app: each tenant's payout terms (platform fee, earnings hold,
 * minimum withdrawal), the clients' payments with refunds, and the lawyers' wallets. */
export default class PayoutAdminCtrl {
  /** GET /api/admin/settings/payout-settings */
  static async getSettings(_req: Request, res: Response) {
    res.status(200).json(await PayoutSettingsSvc.listForAdmin());
  }

  /** PATCH /api/admin/settings/tenants/:code/payout-settings */
  static async updateSettings(req: Request, res: Response) {
    res.status(200).json(await PayoutSettingsSvc.update(parseTenantCode(req.params.code), validate(settingsSchema, req.body), req.user.userId));
  }

  /** GET /api/admin/quotation-payments[?status=&all=&page=&limit=] */
  static async listPayments(req: Request, res: Response) {
    res.status(200).json(await QuotationPaymentSvc.listForAdmin(validate<{ status?: QuotationPaymentStatus; all: boolean; page: number; limit: number }>(paymentsSchema, req.query)));
  }

  /** POST /api/admin/quotation-payments/:id/refund */
  static async refundPayment(req: Request, res: Response) {
    const body = validate<{ amount?: { amountMinor: number; currency: string }; reason: string }>(refundSchema, req.body);
    res.status(200).json(await QuotationPaymentSvc.refund(req.params.id, body, req.user.userId));
  }

  /** GET /api/admin/wallets[?page=&limit=] */
  static async listWallets(req: Request, res: Response) {
    const { page, limit } = validate<{ page: number; limit: number }>(pageSchema, req.query);
    res.status(200).json(await WalletSvc.listForAdmin(page, limit));
  }
}
