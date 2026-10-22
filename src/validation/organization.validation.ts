import Joi from "joi";
import { OrganizationRole } from "@prisma/client";
import { LAWYER_REGULATORS } from "../types/client-handoff";

const slugSchema = Joi.string()
  .trim()
  .lowercase()
  .pattern(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .min(2)
  .max(60);

const roleSchema = Joi.string().valid(...Object.values(OrganizationRole));

/** "" clears a firm detail, the same as null. */
const firmText = (max: number) => Joi.string().trim().max(max).allow("", null).optional();

/** A firm's details, all optional. The firm regulator and its number are UK only
 * (OrganizationSvc checks the tenant). */
const firmDetails = {
  phone: firmText(40),
  addressLine1: firmText(120),
  addressLine2: firmText(120),
  city: firmText(80),
  postcode: firmText(20),
  firmRegulator: Joi.string()
    .valid(...LAWYER_REGULATORS)
    .allow(null)
    .optional(),
  firmRegistrationNumber: firmText(40),
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
