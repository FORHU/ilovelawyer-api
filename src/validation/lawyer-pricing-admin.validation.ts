import Joi from "joi";

// Amounts are in pence (GBP, like every quote). LawyerPricingSvc checks them against Stripe's
// minimum and our ceiling.
const amountMinor = Joi.number().integer().min(1);

export const updateLawyerIntroFeeSchema = Joi.object({
  priceMinor: amountMinor.required(),
});

export const createLawyerPackSchema = Joi.object({
  code: Joi.string().trim().min(1).max(32).required(),
  name: Joi.string().trim().min(1).max(100).required(),
  priceMinor: amountMinor.required(),
  creditMinor: amountMinor.required(),
});

// No `code`: it's what the lawyer app sends back to buy the pack, set once at create.
export const updateLawyerPackSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).optional(),
  priceMinor: amountMinor.optional(),
  creditMinor: amountMinor.optional(),
  level: Joi.number().integer().min(0).optional(),
  isActive: Joi.boolean().strict().optional(),
}).min(1);
