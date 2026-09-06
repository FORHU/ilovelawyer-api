import Joi from "joi";
import { OrganizationRole } from "@prisma/client";

const slugSchema = Joi.string()
  .trim()
  .lowercase()
  .pattern(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .min(2)
  .max(60);

const roleSchema = Joi.string().valid(...Object.values(OrganizationRole));

export const createOrganizationSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).required(),
  packageSku: Joi.string().valid("SOLO", "PROFESSIONAL", "ENTERPRISE").optional(),
});

export const updateOrganizationSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).optional(),
  slug: slugSchema.optional(),
}).min(1);

export const inviteMemberSchema = Joi.object({
  email: Joi.string().trim().email().required(),
  role: roleSchema.default(OrganizationRole.MEMBER),
});

export const changeMemberRoleSchema = Joi.object({ role: roleSchema.required() });

export const attachCaseToOrganizationSchema = Joi.object({ caseId: Joi.string().required() });
