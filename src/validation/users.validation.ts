import Joi from "joi";

export const updateMeSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).optional(),
  username: Joi.string()
    .trim()
    .min(3)
    .max(30)
    .pattern(/^[a-zA-Z0-9._]+$/)
    .optional(),
}).min(1);
