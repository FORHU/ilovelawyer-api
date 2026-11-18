import Joi from "joi";

export const updatePersonaRoutingOverrideSchema = Joi.object({
  routingMode: Joi.string().valid("AUTO", "MANUAL").required(),
  // Required by PersonaRoutingOverrideSvc when routingMode is MANUAL (checked there, not here,
  // so the two fields' cross-validation lives in one place).
  manualPinnedModel: Joi.string().trim().min(1).max(100).allow(null).optional(),
  toolOverrides: Joi.object().pattern(Joi.string(), Joi.string().trim().min(1).max(100)).allow(null).optional(),
});
