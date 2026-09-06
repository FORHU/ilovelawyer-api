import Joi from "joi";
import { JURIS_PH_CASE_TYPES, JURIS_PH_TOPICS } from "../utils/juris-ph";

export const lawSearchSchema = Joi.object({
  category: Joi.string().valid("jurisprudence", "republic-acts").required(),
  q: Joi.string().trim().min(1).max(300).required(),
  limit: Joi.number().integer().min(1).max(20).default(5),
});

export const lawDocumentSchema = Joi.object({
  category: Joi.string().valid("jurisprudence", "republic-acts").required(),
  id: Joi.string().trim().min(1).max(200).required(),
});

export const lawBrowseSchema = Joi.object({
  category: Joi.string().valid("jurisprudence", "republic-acts").required(),
  // jurisprudence-only; ignored (rejected) for republic-acts.
  caseType: Joi.string()
    .valid(...JURIS_PH_CASE_TYPES)
    .optional(),
  // csv, e.g. "criminal,labor"
  topics: Joi.string()
    .custom((raw: string, helpers) => {
      const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
      const bad = list.find((t) => !(JURIS_PH_TOPICS as readonly string[]).includes(t));
      if (bad) return helpers.error("any.invalid", { bad });
      return list;
    })
    .optional(),
  year: Joi.number().integer().min(1900).max(2100).optional(),
  cursor: Joi.string().max(20000).optional(),
  limit: Joi.number().integer().min(1).max(20).default(20),
});
