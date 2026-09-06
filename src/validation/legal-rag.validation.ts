import Joi from "joi";

export const legalRagCategoriesSchema = Joi.object({ category: Joi.string().optional() });

export const legalRagListSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  category: Joi.string().optional(),
  subcategory: Joi.string().optional(),
  noSubcategory: Joi.boolean().optional(),
  year: Joi.number().integer().optional(),
  search: Joi.string().optional(),
});

export const legalRagVectorSearchSchema = Joi.object({
  embedding: Joi.array().items(Joi.number()).min(1).required(),
  limit: Joi.number().integer().min(1).max(100).default(10),
  offset: Joi.number().integer().min(0).default(0),
  minSimilarity: Joi.number().min(0).max(1).default(0.3),
});

export const legalRagGetRelatedSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(20).default(5),
});

export const legalRagFormatDocumentSchema = Joi.object({
  force: Joi.boolean().default(false),
  generate_title: Joi.boolean().default(true),
});

export const legalRagFormatDocumentsSchema = Joi.object({
  force: Joi.boolean().default(false),
  all: Joi.boolean().default(false),
  generate_title: Joi.boolean().default(true),
  limit: Joi.number().integer().min(1).optional(),
  delay: Joi.number().min(0).optional(),
});

export const legalRagSearchSchema = Joi.object({
  q: Joi.string().min(2).required(),
  limit: Joi.number().integer().min(1).max(20).default(5),
});
