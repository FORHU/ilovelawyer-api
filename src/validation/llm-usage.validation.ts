import Joi from "joi";
import { LLM_USAGE_PAGE_SIZE_DEFAULT, LLM_USAGE_PAGE_SIZE_MAX } from "../constants/llm-usage.constants";

const filterKeys = {
  // Inclusive lower and exclusive upper bound, like the security audit log. `from` defaults in the
  // controller (the last 30 days), not here, so "no range" and "an invalid range" stay distinct.
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional(),
  provider: Joi.string().valid("OPENAI", "TYPESAFE").optional(),
  model: Joi.string().trim().max(128).optional(),
  feature: Joi.string().trim().max(128).optional(),
  source: Joi.string().valid("ESTIMATED", "REPORTED").optional(),
  organizationId: Joi.string().trim().max(64).optional(),
  userId: Joi.string().trim().max(64).optional(),
  caseId: Joi.string().trim().max(64).optional(),
};

export const llmUsageSummarySchema = Joi.object(filterKeys);

export const llmUsagePeopleSchema = Joi.object({
  from: filterKeys.from,
  to: filterKeys.to,
  organizationId: filterKeys.organizationId,
  userId: filterKeys.userId,
});

export const llmUsageListSchema = Joi.object({
  ...filterKeys,
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(LLM_USAGE_PAGE_SIZE_MAX).default(LLM_USAGE_PAGE_SIZE_DEFAULT),
});
