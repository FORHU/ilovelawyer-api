import Joi from "joi";

export const visitorActionSchema = Joi.object({
  email: Joi.string().trim().email().max(254).required(),
});
