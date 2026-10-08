import Joi from "joi";

export const listUsersSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  sortBy: Joi.string().valid("name", "email", "createdAt", "lastLoginAt").default("createdAt"),
  sortDir: Joi.string().valid("asc", "desc").default("desc"),
  q: Joi.string().trim().max(200).optional(),
});

export const listAuditEventsSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  sortDir: Joi.string().valid("asc", "desc").default("desc"),
  q: Joi.string().trim().max(200).optional(),
  actorId: Joi.string().uuid().optional(),
});

// An admin exporting someone's data can't re-enter that person's password, so they confirm
// instead that they have checked who is asking. It has to be an explicit true, never defaulted.
export const exportUserDataSchema = Joi.object({
  identityVerified: Joi.boolean().strict().valid(true).required().messages({
    "any.only": "Confirm that you have verified the requester's identity",
    "any.required": "Confirm that you have verified the requester's identity",
  }),
});

export const denyUserSchema =Joi.object({ reason: Joi.string().trim().max(500).allow("").optional() });

export const updateUserTenantSchema = Joi.object({ tenantCode: Joi.string().valid("PH", "UK").required() });

// strict(): only a real JSON boolean — "true"/"false"/1/0 are rejected, not coerced.
export const updateTenantSettingsSchema = Joi.object({ autoApproveSignups: Joi.boolean().strict().required() });

export const lawSearchSchema = Joi.object({
  category: Joi.string().valid("jurisprudence", "republic-acts").required(),
  q: Joi.string().trim().min(1).max(300).required(),
  limit: Joi.number().integer().min(1).max(20).default(5),
});

export const listLawsSchema = Joi.object({
  category: Joi.string().valid("jurisprudence", "republic-acts").optional(),
  q: Joi.string().trim().max(300).optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  sortBy: Joi.string().valid("year", "createdAt").default("createdAt"),
  sortDir: Joi.string().valid("asc", "desc").default("desc"),
});
