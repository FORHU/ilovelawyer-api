import Joi from "joi";
import { SECURITY_AUDIT_ACTIONS, SECURITY_AUDIT_PAGE_SIZE_MAX } from "../constants/security-audit.constants";

/** A whole group of actions ("auth.") as well as an exact one. */
const ACTION_GROUPS = [...new Set(SECURITY_AUDIT_ACTIONS.map((action) => `${action.split(".")[0]}.`))];

const filterKeys = {
  actorId: Joi.string().trim().max(64).optional(),
  caseId: Joi.string().trim().max(64).optional(),
  action: Joi.string()
    .valid(...SECURITY_AUDIT_ACTIONS, ...ACTION_GROUPS)
    .optional(),
  outcome: Joi.string().valid("SUCCESS", "FAILURE").optional(),
  from: Joi.date().iso().optional(),
  // Exclusive upper bound.
  to: Joi.date().iso().optional(),
};

export const securityAuditListSchema = Joi.object({
  ...filterKeys,
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(SECURITY_AUDIT_PAGE_SIZE_MAX).default(SECURITY_AUDIT_PAGE_SIZE_MAX),
});

export const securityAuditExportSchema = Joi.object(filterKeys);

/** Platform admins can also narrow to one organization, or to events outside any ("none"). */
export const adminSecurityAuditListSchema = securityAuditListSchema.keys({
  organizationId: Joi.string().trim().max(64).optional(),
});

export const adminSecurityAuditExportSchema = securityAuditExportSchema.keys({
  organizationId: Joi.string().trim().max(64).optional(),
});
