import Joi from "joi";

export const createScreenPresetSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).required(),
  description: Joi.string().trim().max(2000).allow("").optional(),
  screens: Joi.array().items(Joi.object()).min(1).required(),
});

export const updateScreenPresetSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).optional(),
  description: Joi.string().trim().max(2000).allow("").optional(),
  screens: Joi.array().items(Joi.object()).min(1).optional(),
}).min(1);
