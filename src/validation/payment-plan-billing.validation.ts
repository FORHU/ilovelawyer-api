import Joi from "joi";

export const startPaymentPlanCheckoutSchema = Joi.object({
  planCode: Joi.string().trim().min(1).max(40).required(),
});

/** The tier to change a live subscription to, for its preview (query) and the change itself (body). */
export const changePaymentPlanSchema = startPaymentPlanCheckoutSchema;
