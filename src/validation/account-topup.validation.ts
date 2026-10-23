import Joi from "joi";

export const quoteAccountTopUpSchema = Joi.object({
  topUpAmountUsd: Joi.number().positive().required(),
});

export const startAccountTopUpCheckoutSchema = Joi.object({
  topUpAmountUsd: Joi.number().positive().required(),
});
