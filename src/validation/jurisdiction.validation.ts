import Joi from "joi";

export const setJurisdictionEnabledSchema = Joi.object({ enabled: Joi.boolean().required() });

export const createIntegrationSchema = Joi.object({
  type: Joi.string().valid("DMS", "EMAIL", "CALENDAR", "EFILING", "LEGAL_DATABASE").required(),
  organizationId: Joi.string().optional(),
  configJson: Joi.object().optional(),
});

export const connectIntegrationSchema = Joi.object({ configJson: Joi.object().optional() });
