import { Request, Response } from "express";
import Joi from "joi";
import PayoutSettingsSvc from "../services/payout-settings.service";
import QuotationPaymentSvc from "../services/quotation-payment.service";
import WalletSvc from "../services/wallet.service";
import LawyerExitSvc from "../services/lawyer-exit.service";
import LawyerSubscriptionAdminSvc, { LAWYER_SUBSCRIPTION_FILTERS, type LawyerSubscriptionFilter } from "../services/lawyer-subscription-admin.service";
import { LAWYER_EXIT_STATUSES, QUOTATION_PAYMENT_STATUSES, type LawyerExitStatus, type QuotationPaymentStatus } from "../types/client-handoff";
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

const lawyerExitsSchema = Joi.object({
  /** OPEN (the default): every exit not settled yet. ALL: every one. Or one status. */
  status: Joi.string()
    .valid("OPEN", "ALL", ...LAWYER_EXIT_STATUSES)
    .default("OPEN"),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});
const lawyerSubscriptionsSchema = Joi.object({
  status: Joi.string()
    .valid(...LAWYER_SUBSCRIPTION_FILTERS)
    .default("ALL"),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});
const decideSchema = Joi.object({
  /** What the client gets back: 0 for nothing, at most the lawyer's share for part, or everything left. */
  refund: Joi.object({
    amountMinor: Joi.number().integer().min(0).required(),
    currency: Joi.string().valid("GBP").required(),
  }).required(),
  note: Joi.string().trim().allow("").max(1000).optional(),
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
 * minimum withdrawal), the clients' payments with refunds, the lawyers' wallets, and the Lawyer Exits
 * waiting on a decision. */
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

  /** GET /api/admin/lawyer-exits[?status=OPEN|ALL|<status>&page=&limit=] */
  static async listLawyerExits(req: Request, res: Response) {
    res.status(200).json(await LawyerExitSvc.listForAdmin(validate<{ status: LawyerExitStatus | "OPEN" | "ALL"; page: number; limit: number }>(lawyerExitsSchema, req.query)));
  }

  /** GET /api/admin/lawyer-exits/:id */
  static async getLawyerExit(req: Request, res: Response) {
    res.status(200).json(await LawyerExitSvc.getForAdmin(req.params.id));
  }

  /** POST /api/admin/lawyer-exits/:id/decide */
  static async decideLawyerExit(req: Request, res: Response) {
    const body = validate<{ refund: { amountMinor: number; currency: string }; note?: string }>(decideSchema, req.body);
    res.status(200).json(await LawyerExitSvc.decide(req.params.id, { amount: body.refund, note: body.note }, req.user.userId));
  }

  /** GET /api/admin/lawyer-subscriptions[?status=ALL|ACTIVE|PAST_DUE|CHANGING|ENDED|PENDING&page=&limit=] */
  static async listLawyerSubscriptions(req: Request, res: Response) {
    res.status(200).json(await LawyerSubscriptionAdminSvc.list(validate<{ status: LawyerSubscriptionFilter; page: number; limit: number }>(lawyerSubscriptionsSchema, req.query)));
  }

  /** GET /api/admin/wallets[?page=&limit=] */
  static async listWallets(req: Request, res: Response) {
    const { page, limit } = validate<{ page: number; limit: number }>(pageSchema, req.query);
    res.status(200).json(await WalletSvc.listForAdmin(page, limit));
  }
}
