import Joi from "joi";
import { LAWYER_REJECTION_REASONS } from "../services/lawyer-verification.service";
import { LAWYER_VERIFICATION_STATUSES, UK_JURISDICTIONS } from "../types/client-handoff";

export const listUsersSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  sortBy: Joi.string().valid("name", "email", "createdAt", "lastLoginAt").default("createdAt"),
  sortDir: Joi.string().valid("asc", "desc").default("desc"),
  q: Joi.string().trim().max(200).optional(),
  // LAWYER = ilovelawyer-app accounts, USER = client app accounts; omitted = both.
  role: Joi.string().valid("LAWYER", "USER").optional(),
});

export const listAuditEventsSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  sortDir: Joi.string().valid("asc", "desc").default("desc"),
  q: Joi.string().trim().max(200).optional(),
  actorId: Joi.string().uuid().optional(),
});

export const listFeedbackSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  sortDir: Joi.string().valid("asc", "desc").default("desc"),
  // Matches the sender's email or name. The comment is sealed at rest, so it can't be searched.
  q: Joi.string().trim().max(200).optional(),
  source: Joi.string().valid("GENERAL", "CHAT_ANSWER", "TERMINAL_PANE").optional(),
  rating: Joi.string().valid("UP", "DOWN").optional(),
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

export const listLawyerVerificationsSchema = Joi.object({
  status: Joi.string()
    .valid(...LAWYER_VERIFICATION_STATUSES)
    .default("PENDING"),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

// The jurisdictions the admin confirmed against the register replace what the lawyer claimed.
export const verifyLawyerSchema = Joi.object({
  confirmedJurisdictions: Joi.array()
    .items(Joi.string().valid(...UK_JURISDICTIONS))
    .min(1)
    .unique()
    .required(),
  note: Joi.string().trim().max(1000).allow("").optional(),
});

// note is required for OTHER (it's the whole message); optional extra detail for the canned reasons.
export const rejectLawyerSchema = Joi.object({
  reason: Joi.string()
    .valid(...LAWYER_REJECTION_REASONS)
    .required(),
  note: Joi.string()
    .trim()
    .max(1000)
    .when("reason", { is: "OTHER", then: Joi.required(), otherwise: Joi.optional() }),
});

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
