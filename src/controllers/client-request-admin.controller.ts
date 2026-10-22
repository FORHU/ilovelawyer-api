import { Request, Response } from "express";
import Joi from "joi";
import ClientRequestAdminSvc from "../services/client-request-admin.service";
import { CLIENT_REQUEST_STATUSES } from "../types/client-handoff";
import type { AdminRequestFilter } from "../repositories/client-request-admin.repository";
import HttpError from "../utils/http-error";

const page = {
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(25),
};

const listSchema = Joi.object({
  status: Joi.string()
    .valid(...CLIENT_REQUEST_STATUSES)
    .optional(),
  minAgeHours: Joi.number().min(0).max(24 * 365).optional(),
  unclaimedOver48h: Joi.boolean().optional(),
  caseId: Joi.string().trim().max(64).optional(),
  ...page,
});

const feesSummarySchema = Joi.object({
  groupBy: Joi.string().valid("organization", "lawyer").default("organization"),
  // Inclusive dates; `to` is the last day counted.
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional(),
});

const refundSchema = Joi.object({
  /** Left out: everything not yet refunded. */
  amount: Joi.object({
    amountMinor: Joi.number().integer().min(1).required(),
    currency: Joi.string().valid("GBP").required(),
  }).optional(),
  reason: Joi.string().trim().min(1).max(500).required(),
});

function validate<T>(schema: Joi.ObjectSchema, input: unknown): T {
  const { error, value } = schema.validate(input ?? {});
  if (error) throw new HttpError(error.message, 400);
  return value as T;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UK client-to-lawyer hand-off for platform admins (ilovelawyer-admin, #520). */
export default class ClientRequestAdminCtrl {
  /** GET /api/admin/client-requests — every request, newest first, filtered by status and age. */
  static async listRequests(req: Request, res: Response) {
    const { page: p, limit, ...filter } = validate<AdminRequestFilter & { page: number; limit: number }>(listSchema, req.query);
    return res.status(200).json(await ClientRequestAdminSvc.listRequests(filter, p, limit));
  }

  /** GET /api/admin/client-requests/fees-summary — fees per organization or lawyer. */
  static async feesSummary(req: Request, res: Response) {
    const { groupBy, from, to } = validate<{ groupBy: "organization" | "lawyer"; from?: Date; to?: Date }>(feesSummarySchema, req.query);
    // `to` names the last day counted, so the range runs to the start of the day after it.
    const end = to ? new Date(to.getTime() + DAY_MS) : undefined;
    if (from && end && from >= end) throw new HttpError("`from` must be on or before `to`", 400);
    return res.status(200).json(await ClientRequestAdminSvc.feesSummary(groupBy, from, end));
  }

  /** GET /api/admin/charges/:chargeId — one firm charge with its refunds. */
  static async getCharge(req: Request, res: Response) {
    return res.status(200).json(await ClientRequestAdminSvc.getCharge(req.params.chargeId));
  }

  /** POST /api/admin/charges/:chargeId/refund — body { amount?, reason }. */
  static async refundCharge(req: Request, res: Response) {
    const body = validate<{ amount?: { amountMinor: number; currency: string }; reason: string }>(refundSchema, req.body);
    return res.status(200).json(await ClientRequestAdminSvc.refundCharge(req.params.chargeId, body, req.user.userId));
  }
}
