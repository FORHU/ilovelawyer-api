import Joi from "joi";
import { SELF_SERVICE_CONSENT_PURPOSES } from "../constants/consent.constants";

export const consentPurposeSchema = Joi.string().valid(...SELF_SERVICE_CONSENT_PURPOSES).required();

export const setConsentSchema = Joi.object({
  granted: Joi.boolean().required(),
});
