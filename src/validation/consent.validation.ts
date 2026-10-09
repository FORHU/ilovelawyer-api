import Joi from "joi";
import { ACTIVE_CONSENT_PURPOSES, CONSENT_SOURCES } from "../constants/consent.constants";

// Every known purpose passes here; ConsentSvc.set then refuses the ones a user can't change
// (Terms of Service) with a message that says so, instead of calling them unknown.
export const consentPurposeSchema = Joi.string().valid(...ACTIVE_CONSENT_PURPOSES).required();

export const setConsentSchema = Joi.object({
  granted: Joi.boolean().required(),
  // Where the answer was given; the first-login prompt sends "first_login".
  source: Joi.string().valid(...CONSENT_SOURCES).default("settings"),
});
