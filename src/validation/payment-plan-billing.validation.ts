import Joi from "joi";

export const startPaymentPlanCheckoutSchema = Joi.object({
  planCode: Joi.string().trim().min(1).max(40).required(),
});
