import Joi from "joi";
import { SUPPORT_CONTEXT_LIMITS, SUPPORT_MESSAGE_MAX_LENGTH, SUPPORT_OUTCOME_BATCH_MAX, SUPPORT_UNMATCHED_TEXT_MAX_LENGTH, SUPPORT_REPORT_MAX_DAYS } from "../constants/support-ticket.constants";

const body = Joi.string().trim().min(1).max(SUPPORT_MESSAGE_MAX_LENGTH);
const id = Joi.string().trim().min(1).max(80);

const context = Joi.object({
  flowPath: Joi.array().items(Joi.string().trim().pattern(/^[\w-]+$/).max(SUPPORT_CONTEXT_LIMITS.flowIdLength)).max(SUPPORT_CONTEXT_LIMITS.flowPathLength),
  page: Joi.string().trim().max(SUPPORT_CONTEXT_LIMITS.pageLength).allow(""),
  caseId: id,
  clientRequestId: id,
});

export const clientTicketMessageSchema = Joi.object({ body: body.required(), context });

export const visitorTicketSchema = Joi.object({
  email: Joi.string().trim().email().max(254).required(),
  message: body.required(),
  turnstileToken: Joi.string().trim().max(2048).allow(""),
  context,
});

const outcome = Joi.object({
  kind: Joi.string().valid("FLOW_STARTED", "HELPED_YES", "HELPED_NO", "ESCALATED", "UNMATCHED").required(),
  flowId: Joi.string().trim().pattern(/^[\w-]+$/).max(SUPPORT_CONTEXT_LIMITS.flowIdLength),
  contentVersion: Joi.number().integer().min(1).max(1_000_000),
  text: Joi.string().trim().max(SUPPORT_UNMATCHED_TEXT_MAX_LENGTH * 5),
});

export const outcomesSchema = Joi.object({ events: Joi.array().items(outcome).min(1).max(SUPPORT_OUTCOME_BATCH_MAX).required() });

export const adminReplySchema = Joi.object({ body: body.required() });

export const adminTicketListSchema = Joi.object({
  status: Joi.string().valid("OPEN", "ANSWERED", "RESOLVED"),
  q: Joi.string().trim().max(254).allow(""),
  sort: Joi.string().valid("age", "updated").default("updated"),
  page: Joi.number().integer().min(1).default(1),
});

export const supportReportSchema = Joi.object({
  from: Joi.date().iso().required(),
  to: Joi.date().iso().greater(Joi.ref("from")).required(),
}).custom((value, helpers) => {
  const days = (value.to.getTime() - value.from.getTime()) / (24 * 60 * 60 * 1000);
  return days > SUPPORT_REPORT_MAX_DAYS ? helpers.error("any.invalid") : value;
}, "range length");
