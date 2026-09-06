import Joi from "joi";

export const bookmarkSchema = Joi.object({
  itemId: Joi.string().required(),
  title: Joi.string().required(),
  type: Joi.string().valid("case", "source").required(),
  reference: Joi.string().optional(),
  url: Joi.string().uri().optional(),
  aiSummary: Joi.string().optional(),
  doctrine: Joi.string().optional(),
  facts: Joi.string().optional(),
});
