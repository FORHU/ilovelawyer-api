import Joi from "joi";
import { LAWYER_REGULATORS, UK_JURISDICTIONS } from "../types/client-handoff";
import { FEE_CURRENCY_BY_COUNTRY, PRACTICE_AREAS_BY_COUNTRY, type LawyerCountry } from "../constants/lawyer-application.constants";

export const LAWYER_BIO_MAX_LENGTH = 1500;
/** 10,000 in major units (£ or ₱), as minor units: a ceiling for typos, not a pricing rule. */
const FEE_MAX_MINOR = 1_000_000;

/** A short free-text registration field; "" clears it, the same as null. */
const registrationText = (max: number) => Joi.string().trim().max(max).allow("", null);

const ukRegistrationSchema = Joi.object({
  country: Joi.string().valid("UK").required(),
  regulator: Joi.string()
    .valid(...LAWYER_REGULATORS)
    .allow(null),
  registrationNumber: registrationText(40),
  qualifiedJurisdictions: Joi.array()
    .items(Joi.string().valid(...UK_JURISDICTIONS))
    .unique(),
});

const phRegistrationSchema = Joi.object({
  country: Joi.string().valid("PH").required(),
  rollNumber: registrationText(40),
  ibpChapter: registrationText(80),
  ibpMembershipNumber: registrationText(40),
  mcleNumber: registrationText(40),
  mclePeriod: registrationText(20),
});

/** A save to a lawyer's application. The registration, practice areas and fee currency are the
 * lawyer's own country's: UK ones never validate on a PH application, and the other way round. */
export function updateLawyerProfileSchema(country: LawyerCountry) {
  return Joi.object({
    registration: country === "PH" ? phRegistrationSchema : ukRegistrationSchema,
    // UK: never personal injury (referral fees are banned there), so it isn't in the list.
    practiceAreas: Joi.array()
      .items(Joi.string().valid(...PRACTICE_AREAS_BY_COUNTRY[country]))
      .unique(),
    bio: Joi.string().allow("").max(LAWYER_BIO_MAX_LENGTH),
    languages: Joi.array().items(Joi.string().trim().min(1).max(40)).max(10).unique(),
    firstConsultationFee: Joi.object({
      amountMinor: Joi.number().integer().min(0).max(FEE_MAX_MINOR).required(),
      currency: Joi.string().valid(FEE_CURRENCY_BY_COUNTRY[country]).required(),
    }).allow(null),
    acceptingRequests: Joi.boolean(),
    pausedUntil: Joi.date().iso().allow(null),
    capacityLimit: Joi.number().integer().min(1).max(100).allow(null),
  }).min(1);
}
