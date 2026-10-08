import Joi from "joi";
import { CONSENT_VERSIONS } from "../constants/consent.constants";

// Every known purpose passes here; ConsentSvc.set then refuses the ones a user can't change
// (Terms of Service) with a message that says so, instead of calling them unknown.
export const consentPurposeSchema = Joi.string().valid(...Object.keys(CONSENT_VERSIONS)).required();

export const setConsentSchema = Joi.object({
  granted: Joi.boolean().required(),
});
