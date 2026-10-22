import Joi from "joi";
import {
  CLIENT_BILLING_PAGE_SIZE_DEFAULT,
  CLIENT_BILLING_PAGE_SIZE_MAX,
  CLIENT_REFUND_REASON_MAX,
} from "../constants/client-billing-admin.constants";

const page = {
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(CLIENT_BILLING_PAGE_SIZE_MAX).default(CLIENT_BILLING_PAGE_SIZE_DEFAULT),
};

const filterKeys = {
  // Inclusive lower and exclusive upper bound, like the LLM usage endpoints. `from` defaults in the
  // controller (the last 30 days).
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional(),
  userId: Joi.string().trim().max(64).optional(),
  caseId: Joi.string().trim().max(64).optional(),
  status: Joi.string().valid("PENDING", "SUCCEEDED", "FAILED").optional(),
  kind: Joi.string().valid("CASE", "TOP_UP").optional(),
  provider: Joi.string().valid("DUMMY", "STRIPE", "FREE").optional(),
  q: Joi.string().trim().max(200).optional(),
};

export const clientBillingSummarySchema = Joi.object(filterKeys);

export const clientBillingListSchema = Joi.object({ ...filterKeys, ...page });

export const clientBillingClientSchema = Joi.object(page);

export const clientRefundSchema = Joi.object({
  /** Left out: everything not yet refunded. */
  amountMinor: Joi.number().integer().min(1).optional(),
  reason: Joi.string().trim().min(1).max(CLIENT_REFUND_REASON_MAX).required(),
});
