import Joi from "joi";
import { LAWYER_REGULATORS, PRACTICE_AREAS, UK_JURISDICTIONS } from "../types/client-handoff";

export const LAWYER_BIO_MAX_LENGTH = 1500;
/** £10,000 in pence: a ceiling for typos, not a pricing rule. */
const FEE_MAX_MINOR = 1_000_000;

export const updateLawyerProfileSchema = Joi.object({
  regulator: Joi.string()
    .valid(...LAWYER_REGULATORS)
    .allow(null),
  registrationNumber: Joi.string().trim().max(40).allow("", null),
  qualifiedJurisdictions: Joi.array()
    .items(Joi.string().valid(...UK_JURISDICTIONS))
    .unique(),
  // Personal injury isn't in PRACTICE_AREAS: referral fees are banned there.
  practiceAreas: Joi.array()
    .items(Joi.string().valid(...PRACTICE_AREAS))
    .unique(),
  bio: Joi.string().allow("").max(LAWYER_BIO_MAX_LENGTH),
  languages: Joi.array().items(Joi.string().trim().min(1).max(40)).max(10).unique(),
  firstConsultationFee: Joi.object({
    amountMinor: Joi.number().integer().min(0).max(FEE_MAX_MINOR).required(),
    currency: Joi.string().valid("GBP").required(),
  }).allow(null),
  acceptingRequests: Joi.boolean(),
  pausedUntil: Joi.date().iso().allow(null),
  capacityLimit: Joi.number().integer().min(1).max(100).allow(null),
}).min(1);
