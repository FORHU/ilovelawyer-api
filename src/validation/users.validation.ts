import Joi from "joi";
import { ProductTourStatus } from "@prisma/client";
import { PRODUCT_TOUR_ARCHETYPES, PRODUCT_TOUR_MAX_STEPS, PRODUCT_TOUR_STEP_ID_MAX } from "../constants";

// Must stay in sync with apps/web/lib/auth/password-policy.ts in ilovelawyer-app
const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9]).{10,}$/;
const PASSWORD_MESSAGE =
  "Password must be at least 10 characters and include an uppercase letter, a lowercase letter, a number, and a special character.";

export const updateMeSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).optional(),
  username: Joi.string()
    .trim()
    .min(3)
    .max(30)
    .pattern(/^[a-zA-Z0-9._]+$/)
    .optional(),
}).min(1);

export const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string().pattern(PASSWORD_PATTERN).required().messages({
    "string.pattern.base": PASSWORD_MESSAGE,
  }),
});

// Optional here: UsersSvc.requestDeletion decides whether the account needs one (Google SSO
// accounts have no password).
export const deleteMeSchema = Joi.object({
  password: Joi.string().max(1024).optional(),
});

// The one-time code from the app's Google auth-code popup (Connect Google Calendar).
export const connectGoogleCalendarSchema = Joi.object({
  code: Joi.string().trim().max(2048).required(),
});

// Step ids are the app's own slugs — kebab or camelCase, e.g. "nextdate", "legalIssues".
const tourStepIdSchema = Joi.string()
  .trim()
  .max(PRODUCT_TOUR_STEP_ID_MAX)
  .pattern(/^[A-Za-z0-9-]+$/);

export const saveProductTourSchema = Joi.object({
  status: Joi.string()
    .valid(...Object.values(ProductTourStatus))
    .required(),
  archetype: Joi.string()
    .valid(...PRODUCT_TOUR_ARCHETYPES)
    .allow(null)
    .default(null),
  currentStep: tourStepIdSchema.allow(null).default(null),
  doneSteps: Joi.array().items(tourStepIdSchema).max(PRODUCT_TOUR_MAX_STEPS).default([]),
});
