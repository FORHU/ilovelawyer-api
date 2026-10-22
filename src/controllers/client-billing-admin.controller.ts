import { Request, Response } from "express";
import Joi from "joi";
import ClientBillingAdminSvc from "../services/client-billing-admin.service";
import { ClientBillingFilter } from "../repositories/client-billing-admin.repository";
import {
  clientBillingClientSchema,
  clientBillingListSchema,
  clientBillingSummarySchema,
  clientRefundSchema,
} from "../validation/client-billing-admin.validation";
import { CLIENT_BILLING_DEFAULT_RANGE_DAYS } from "../constants/client-billing-admin.constants";
import HttpError from "../utils/http-error";

function validate<T>(schema: Joi.ObjectSchema, input: unknown): T {
  const { error, value } = schema.validate(input ?? {});
  if (error) throw new HttpError(error.message, 400);
  return value as T;
}

type Query = ClientBillingFilter & { page?: number; limit?: number };

/** The last CLIENT_BILLING_DEFAULT_RANGE_DAYS days (before `to`, else before now) when no `from` is named. */
export function toFilter(query: Query): ClientBillingFilter {
  const { from, to, userId, caseId, status, kind, provider, q } = query;
  const start = from ?? new Date((to ?? new Date()).getTime() - CLIENT_BILLING_DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
  if (to && start >= to) throw new HttpError("`from` must be before `to`", 400);
  return { from: start, to, userId, caseId, status, kind, provider, q };
}

/** Client app payments for platform admins (ilovelawyer-admin's Billing page, #538). */
export default class ClientBillingAdminCtrl {
  /** GET /api/admin/billing/summary — revenue, refunds and splits over a range. */
  static async summary(req: Request, res: Response) {
    const filter = toFilter(validate<Query>(clientBillingSummarySchema, req.query));
    const summary = await ClientBillingAdminSvc.summary(filter);
    return res.status(200).json({ range: { from: filter.from, to: filter.to ?? null }, ...summary });
  }

  /** GET /api/admin/billing — one page of payments, newest first. */
  static async list(req: Request, res: Response) {
    const query = validate<Query>(clientBillingListSchema, req.query);
    return res.status(200).json(await ClientBillingAdminSvc.list(toFilter(query), query.page!, query.limit!));
  }

  /** GET /api/admin/billing/clients/:userId — one client's billing, all time. */
  static async client(req: Request, res: Response) {
    const query = validate<{ page: number; limit: number }>(clientBillingClientSchema, req.query);
    return res.status(200).json(await ClientBillingAdminSvc.client(req.params.userId, query.page, query.limit));
  }

  /** GET /api/admin/billing/:id — one payment with its refunds. */
  static async get(req: Request, res: Response) {
    return res.status(200).json(await ClientBillingAdminSvc.get(req.params.id));
  }

  /** POST /api/admin/billing/:id/refund — body { amountMinor?, reason }. */
  static async refund(req: Request, res: Response) {
    const body = validate<{ amountMinor?: number; reason: string }>(clientRefundSchema, req.body);
    return res.status(200).json(await ClientBillingAdminSvc.refund(req.params.id, body, req.user.userId));
  }
}
