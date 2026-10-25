import Joi from "joi";
import { LAWYER_REJECTION_REASONS } from "../services/lawyer-verification.service";
import { LAWYER_VERIFICATION_STATUSES, UK_JURISDICTIONS } from "../types/client-handoff";
import { LAWYER_COUNTRIES } from "../constants/lawyer-application.constants";

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
  site: Joi.string()
    .valid(...LAWYER_COUNTRIES)
    .default("UK"),
  status: Joi.string()
    .valid(...LAWYER_VERIFICATION_STATUSES)
    .default("PENDING"),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

// UK: the jurisdictions the admin confirmed against the register replace what the lawyer claimed;
// LawyerVerificationSvc.verify requires them there. PH has none, so it sends only the note.
export const verifyLawyerSchema = Joi.object({
  confirmedJurisdictions: Joi.array()
    .items(Joi.string().valid(...UK_JURISDICTIONS))
    .min(1)
    .unique()
    .optional(),
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

// strict(): only a real JSON boolean — "true"/"false"/1/0 are rejected, not coerced. At least one
// of the two independent settings groups (signup auto-approve, account top-up fee) must be
// present; each group's own fields travel together. The old flat subscriptionPlan* fields are
// retired — per-tier pricing now goes through the payment-plans endpoints below.
export const updateTenantSettingsSchema = Joi.object({
  autoApproveSignups: Joi.boolean().strict().optional(),
  accountTopUpFeeType: Joi.string().valid("FIXED", "PERCENT").optional(),
  accountTopUpFeeAmount: Joi.number().min(0).optional(),
})
  .and("accountTopUpFeeType", "accountTopUpFeeAmount")
  .or("autoApproveSignups", "accountTopUpFeeType");

export const createPaymentPlanSchema = Joi.object({
  code: Joi.string().trim().min(1).max(40).required(),
  name: Joi.string().trim().min(1).max(100).required(),
  // Shown to the lawyer on the plan picker.
  description: Joi.string().trim().max(300).allow("").optional(),
  // Admin-only — never returned to a lawyer.
  adminNotes: Joi.string().trim().max(1000).allow("").optional(),
  level: Joi.number().integer().min(0).optional(),
  feeUsd: Joi.number().min(0).required(),
  includedAllowanceUsd: Joi.number().min(0).required(),
  caseLimit: Joi.number().integer().min(0).required(),
  // Client requests a lawyer can take on per calendar month; 0 = unlimited. Optional: older admin
  // builds don't send it, and it defaults to 0.
  clientRequestLimit: Joi.number().integer().min(0).optional(),
});

// No `code`: it's the stable slug signup and upgrades refer to, set once at create.
export const updatePaymentPlanSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).optional(),
  description: Joi.string().trim().max(300).allow("").optional(),
  adminNotes: Joi.string().trim().max(1000).allow("").optional(),
  level: Joi.number().integer().min(0).optional(),
  feeUsd: Joi.number().min(0).optional(),
  includedAllowanceUsd: Joi.number().min(0).optional(),
  caseLimit: Joi.number().integer().min(0).optional(),
  clientRequestLimit: Joi.number().integer().min(0).optional(),
  isActive: Joi.boolean().strict().optional(),
}).min(1);

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
