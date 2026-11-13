import Joi from "joi";
import { LAWYER_REGULATORS, UK_JURISDICTIONS } from "../types/client-handoff";
import {
  FEE_CURRENCY_BY_COUNTRY,
  FEE_MAX_MINOR_BY_COUNTRY,
  KR_LOCAL_BARS,
  KR_QUALIFICATION_ROUTES,
  type LawyerCountry,
} from "../constants/lawyer-application.constants";
import { DIGITS_PATTERN, MCLE_NUMBER_PATTERN, NUMBER_MAX_DIGITS, ROMAN_NUMERAL_PATTERN, WORDS_PATTERN } from "../constants/field-rules";

export const LAWYER_BIO_MAX_LENGTH = 1500;
/** A bar exam round or JRTI class number: well above any held so far, to catch typos. */
const KR_COHORT_MAX = 200;
/** Korean Bar Association specialist areas: a short list of short names. */
const KR_SPECIALTIES_MAX = 10;
const KR_SPECIALTY_MAX_LENGTH = 40;

/** A short registration field; "" clears it, the same as null. Each holds only what fits it (see
 * constants/field-rules.ts): digits for the numbers, letters for the IBP chapter. */
const registrationText = (max: number, pattern: RegExp, name: string) => Joi.string().trim().max(max).pattern(pattern, name).allow("", null);
const registrationNumber = (max = NUMBER_MAX_DIGITS) => registrationText(max, DIGITS_PATTERN, "digits");

const ukRegistrationSchema = Joi.object({
  country: Joi.string().valid("UK").required(),
  regulator: Joi.string()
    .valid(...LAWYER_REGULATORS)
    .allow(null),
  registrationNumber: registrationNumber(),
  qualifiedJurisdictions: Joi.array()
    .items(Joi.string().valid(...UK_JURISDICTIONS))
    .unique(),
});

const phRegistrationSchema = Joi.object({
  country: Joi.string().valid("PH").required(),
  rollNumber: registrationNumber(),
  ibpChapter: registrationText(80, WORDS_PATTERN, "letters"),
  ibpMembershipNumber: registrationNumber(20),
  mcleNumber: registrationText(40, MCLE_NUMBER_PATTERN, "MCLE number"),
  mclePeriod: registrationText(10, ROMAN_NUMERAL_PATTERN, "Roman numerals"),
});

const krRegistrationSchema = Joi.object({
  country: Joi.string().valid("KR").required(),
  registrationNumber: registrationNumber(),
  localBar: Joi.string()
    .valid(...KR_LOCAL_BARS)
    .allow(null),
  qualificationRoute: Joi.string()
    .valid(...KR_QUALIFICATION_ROUTES)
    .allow(null),
  qualificationCohort: Joi.number().integer().min(1).max(KR_COHORT_MAX).allow(null),
  specialties: Joi.array().items(Joi.string().trim().min(1).max(KR_SPECIALTY_MAX_LENGTH).pattern(WORDS_PATTERN, "letters")).max(KR_SPECIALTIES_MAX).unique(),
  // A calendar date, not in the future.
  registeredOn: Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
    .custom((value: string, helpers) => {
      const date = new Date(`${value}T00:00:00.000Z`);
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return helpers.message({ custom: "registeredOn must be a real date" });
      return date.getTime() > Date.now() ? helpers.message({ custom: "registeredOn can't be in the future" }) : value;
    })
    .allow(null),
});

const REGISTRATION_SCHEMAS: Record<LawyerCountry, Joi.ObjectSchema> = {
  UK: ukRegistrationSchema,
  PH: phRegistrationSchema,
  KR: krRegistrationSchema,
};

/** A save to a lawyer's application. The registration and fee currency are the lawyer's own
 * country's: one country's registration never validates on another's application. Practice areas
 * are ids, checked against the site's list by PracticeAreaSvc.forLawyer. */
export function updateLawyerProfileSchema(country: LawyerCountry) {
  return Joi.object({
    registration: REGISTRATION_SCHEMAS[country],
    practiceAreaIds: Joi.array().items(Joi.string().trim().min(1).max(64)).max(50).unique(),
    bio: Joi.string().allow("").max(LAWYER_BIO_MAX_LENGTH),
    languages: Joi.array().items(Joi.string().trim().min(1).max(40).pattern(WORDS_PATTERN, "letters")).max(10).unique(),
    firstConsultationFee: Joi.object({
      amountMinor: Joi.number().integer().min(0).max(FEE_MAX_MINOR_BY_COUNTRY[country]).required(),
      currency: Joi.string().valid(FEE_CURRENCY_BY_COUNTRY[country]).required(),
    }).allow(null),
    acceptingRequests: Joi.boolean(),
    pausedUntil: Joi.date().iso().allow(null),
    capacityLimit: Joi.number().integer().min(1).max(100).allow(null),
  }).min(1);
}
