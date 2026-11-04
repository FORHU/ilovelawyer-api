import Joi from "joi";
import { UK_JURISDICTIONS } from "../types/client-handoff";

export const LAWYER_SORTS = ["match", "rating", "price"] as const;
export type LawyerSort = (typeof LAWYER_SORTS)[number];

/** GET /client/lawyers: the marketplace's filters. `area` narrows to lawyers who take that case area;
 * `caseArea` (the client's case's) only orders the list, for `sort=match`. `languages` is any of
 * them, with "Other" for any language but English and Welsh. */
export const listClientLawyersSchema = Joi.object({
  area: Joi.string().trim().max(64).optional(),
  caseArea: Joi.string().trim().max(64).optional(),
  jurisdiction: Joi.string()
    .valid(...UK_JURISDICTIONS)
    .optional(),
  maxConsultationMinor: Joi.number().integer().min(0).optional(),
  languages: Joi.array().items(Joi.string().trim().max(64)).single().max(20).default([]),
  q: Joi.string().trim().allow("").max(100).default(""),
  sort: Joi.string()
    .valid(...LAWYER_SORTS)
    .default("match"),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

/** GET /client/lawyers/:id */
export const clientLawyerIdSchema = Joi.object({ id: Joi.string().uuid().required() });

export interface ListClientLawyersQuery {
  area?: string;
  caseArea?: string;
  jurisdiction?: string;
  maxConsultationMinor?: number;
  languages: string[];
  q: string;
  sort: LawyerSort;
  page: number;
  limit: number;
}
