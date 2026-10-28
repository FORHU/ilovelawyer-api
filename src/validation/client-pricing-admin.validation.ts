import Joi from "joi";

// Amounts are in the currency's smallest unit (cents). ClientPricingSvc checks them against the
// currency's Stripe minimum and our ceiling.
const amountMinor = Joi.number().integer().min(0);
const credits = Joi.number().integer().min(1);
const currency = Joi.string().trim().uppercase().length(3);

// A new case is free: only the chat credits it starts with are set.
export const updateClientCasePriceSchema = Joi.object({
  credits: credits.required(),
});

export const createClientPackSchema = Joi.object({
  code: Joi.string().trim().min(1).max(32).required(),
  name: Joi.string().trim().min(1).max(100).required(),
  priceMinor: amountMinor.required(),
  credits: credits.required(),
  currency: currency.required(),
});

// No `code`: it's what the client app sends back to buy the pack, set once at create.
export const updateClientPackSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).optional(),
  priceMinor: amountMinor.optional(),
  credits: credits.optional(),
  currency: currency.optional(),
  level: Joi.number().integer().min(0).optional(),
  isActive: Joi.boolean().strict().optional(),
}).min(1);

const promoFields = {
  description: Joi.string().trim().min(1).max(200),
  discountMinor: Joi.number().integer().min(1),
  currency,
  firstTopUpOnly: Joi.boolean().strict(),
  oncePerClient: Joi.boolean().strict(),
  expiresAt: Joi.date().iso().allow(null),
  maxRedemptions: Joi.number().integer().min(1).allow(null),
  isActive: Joi.boolean().strict(),
};

export const createClientPromoSchema = Joi.object({
  code: Joi.string().trim().min(3).max(32).required(),
  description: promoFields.description.required(),
  discountMinor: promoFields.discountMinor.required(),
  currency: promoFields.currency.required(),
  firstTopUpOnly: promoFields.firstTopUpOnly.default(false),
  oncePerClient: promoFields.oncePerClient.default(false),
  expiresAt: promoFields.expiresAt.default(null),
  maxRedemptions: promoFields.maxRedemptions.default(null),
  isActive: promoFields.isActive.default(true),
});

// No `code`: past payments name it.
export const updateClientPromoSchema = Joi.object(promoFields).min(1);
