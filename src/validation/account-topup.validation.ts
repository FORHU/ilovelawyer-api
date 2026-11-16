import Joi from "joi";

// The amount to top up, in major units of the lawyer's site currency (dollars; won on KR).
// AccountTopUpPricingSvc checks it against that currency's limits.
export const quoteAccountTopUpSchema = Joi.object({
  topUpAmount: Joi.number().positive().required(),
});

export const startAccountTopUpCheckoutSchema = Joi.object({
  topUpAmount: Joi.number().positive().required(),
});
