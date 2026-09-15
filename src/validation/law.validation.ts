import Joi from "joi";
import { LawSourceProvider } from "../legal/law-source/law-source-provider";

/**
 * Tenant-aware schema factories — the accepted `category` and facet vocab come from the
 * caller's `LawSourceProvider` (PH: jurisprudence|republic-acts + caseType/topics;
 * UK: uk-case-law|uk-legislation + court). The controller resolves the provider by tenantCode
 * first, then builds the schema, so PH keeps its exact current strictness and UK gets the same.
 */

export const lawSearchSchema = (p: LawSourceProvider) =>
  Joi.object({
    category: Joi.string()
      .valid(...p.categoryWireValues)
      .required(),
    q: Joi.string().trim().min(1).max(300).required(),
    limit: Joi.number().integer().min(1).max(20).default(5),
  });

export const lawDocumentSchema = (p: LawSourceProvider) =>
  Joi.object({
    category: Joi.string()
      .valid(...p.categoryWireValues)
      .required(),
    // PH: juris.ph source id. UK: our Law.id uuid (a URL wouldn't survive the /laws/:id route).
    id: Joi.string().trim().min(1).max(200).required(),
  });

export const lawBrowseSchema = (p: LawSourceProvider) => {
  const { caseTypes, topics, courts } = p.facetVocab;
  return Joi.object({
    category: Joi.string()
      .valid(...p.categoryWireValues)
      .required(),
    // PH jurisprudence only; rejected for republic-acts by juris.ph itself.
    caseType: caseTypes.length ? Joi.string().valid(...caseTypes).optional() : Joi.forbidden(),
    // PH only — csv, e.g. "criminal,labor".
    topics:
      topics.length > 0
        ? Joi.string()
            .custom((raw: string, helpers) => {
              const list = raw
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              const bad = list.find((t) => !(topics as readonly string[]).includes(t));
              if (bad) return helpers.error("any.invalid", { bad });
              return list;
            })
            .optional()
        : Joi.forbidden(),
    // UK case law only — csv, e.g. "ewca/civ,ewhc/admin". Multiple courts are fanned out to
    // parallel upstream requests and merged (see UkLawSourceProvider.browse).
    court:
      courts.length > 0
        ? Joi.string()
            .custom((raw: string, helpers) => {
              const list = raw
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              const bad = list.find((c) => !(courts as readonly string[]).includes(c));
              if (bad) return helpers.error("any.invalid", { bad });
              return list;
            })
            .optional()
        : Joi.forbidden(),
    year: Joi.number().integer().min(1200).max(2100).optional(),
    // Bumped from 20000: a multi-court browse cursor carries a small per-source leftover buffer
    // for every selected court (see UkLawSourceProvider's cursor shape), which can exceed the
    // old single-court cursor's size when several courts are selected at once.
    cursor: Joi.string().max(100000).optional(),
    limit: Joi.number().integer().min(1).max(20).default(20),
  });
};
