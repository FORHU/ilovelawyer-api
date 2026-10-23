import Joi from "joi";
import { OrganizationRole } from "@prisma/client";
import { LAWYER_REGULATORS } from "../types/client-handoff";
import {
  DIGITS_PATTERN,
  NUMBER_MAX_DIGITS,
  PHONE_MAX_DIGITS,
  PHONE_MIN_DIGITS,
  PHONE_PATTERN,
  WORDS_PATTERN,
} from "../constants/field-rules";

const slugSchema = Joi.string()
  .trim()
  .lowercase()
  .pattern(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .min(2)
  .max(60);

const roleSchema = Joi.string().valid(...Object.values(OrganizationRole));

/** "" clears a firm detail, the same as null. */
const firmText = (max: number) => Joi.string().trim().max(max).allow("", null).optional();

/** Digits and spaces with an optional leading "+", and a sensible number of digits. */
const phoneSchema = firmText(24)
  .pattern(PHONE_PATTERN, "phone number")
  .custom((value: string | null, helpers) => {
    if (!value) return value;
    const digits = value.replace(/\D/g, "").length;
    return digits < PHONE_MIN_DIGITS || digits > PHONE_MAX_DIGITS ? helpers.message({ custom: `phone must have ${PHONE_MIN_DIGITS} to ${PHONE_MAX_DIGITS} digits` }) : value;
  });

/** A firm's details, all optional. The firm regulator and its number are UK only, and the postcode's
 * shape depends on the site (OrganizationSvc checks both against the tenant). Each field holds only
 * what fits it (see constants/field-rules.ts). */
const firmDetails = {
  phone: phoneSchema,
  addressLine1: firmText(120),
  addressLine2: firmText(120),
  city: firmText(80).pattern(WORDS_PATTERN, "letters"),
  postcode: firmText(20),
  firmRegulator: Joi.string()
    .valid(...LAWYER_REGULATORS)
    .allow(null)
    .optional(),
  firmRegistrationNumber: firmText(NUMBER_MAX_DIGITS).pattern(DIGITS_PATTERN, "digits"),
};

export const createOrganizationSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).required(),
  packageSku: Joi.string().valid("SOLO", "PROFESSIONAL", "ENTERPRISE").optional(),
  // Onboarding's "Solo practitioner" — see OrganizationSvc.create. Firm details are ignored for it.
  personal: Joi.boolean().optional(),
  ...firmDetails,
});

export const updateOrganizationSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).optional(),
  slug: slugSchema.optional(),
  ...firmDetails,
}).min(1);

export const inviteMemberSchema = Joi.object({
  email: Joi.string().trim().email().required(),
  role: roleSchema.default(OrganizationRole.MEMBER),
});

export const changeMemberRoleSchema = Joi.object({ role: roleSchema.required() });

export const attachCaseToOrganizationSchema = Joi.object({ caseId: Joi.string().required() });
