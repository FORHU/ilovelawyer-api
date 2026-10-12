import { Request, Response } from "express";
import Joi from "joi";
import LlmUsageSvc from "../services/llm-usage.service";
import { LlmUsageFilter } from "../repositories/llm-usage.repository";
import { llmUsageListSchema, llmUsagePeopleSchema, llmUsageSummarySchema } from "../validation/llm-usage.validation";
import { LLM_USAGE_DEFAULT_RANGE_DAYS } from "../constants/llm-usage.constants";
import HttpError from "../utils/http-error";

function validate<T>(schema: Joi.ObjectSchema, query: unknown): T {
  const { error, value } = schema.validate(query ?? {});
  if (error) throw new HttpError(error.message, 400);
  return value as T;
}

type Query = LlmUsageFilter & { page?: number; limit?: number };

/** The last LLM_USAGE_DEFAULT_RANGE_DAYS days (before `to`, else before now) when no `from` is named. */
export function toFilter(query: Query): LlmUsageFilter {
  const { from, to, provider, model, feature, source, organizationId, userId, caseId } = query;
  const start = from ?? new Date((to ?? new Date()).getTime() - LLM_USAGE_DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
  if (to && start >= to) throw new HttpError("`from` must be before `to`", 400);
  return { from: start, to, provider, model, feature, source, organizationId, userId, caseId };
}

export default class LlmUsageCtrl {
  /** GET /api/admin/llm-usage/summary — totals and breakdowns for platform admins (ilovelawyer-admin). */
  static async summary(req: Request, res: Response) {
    const filter = toFilter(validate<Query>(llmUsageSummarySchema, req.query));
    const summary = await LlmUsageSvc.summary(filter);
    return res.status(200).json({ range: { from: filter.from, to: filter.to ?? null }, ...summary });
  }

  /** GET /api/admin/llm-usage/people — the users and organizations in the range, named, for the
   * page's "who" filters. A chosen organization narrows the users, and a chosen user the organizations. */
  static async people(req: Request, res: Response) {
    const { from, to, organizationId, userId } = toFilter(validate<Query>(llmUsagePeopleSchema, req.query));
    return res.status(200).json(await LlmUsageSvc.people({ from, to, organizationId, userId }));
  }

  /** GET /api/admin/llm-usage — one page of calls, newest first. */
  static async list(req: Request, res: Response) {
    const query = validate<Query>(llmUsageListSchema, req.query);
    const result = await LlmUsageSvc.list(toFilter(query), query.page!, query.limit!);
    return res.status(200).json(result);
  }
}
