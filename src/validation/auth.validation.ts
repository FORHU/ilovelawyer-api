import Joi from "joi";

// Must stay in sync with apps/web/lib/auth/password-policy.ts in ilovelawyer-app
const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9]).{10,}$/;
const PASSWORD_MESSAGE =
  "Password must be at least 10 characters and include an uppercase letter, a lowercase letter, a number, and a special character.";

const strongPassword = Joi.string().pattern(PASSWORD_PATTERN).required().messages({
  "string.pattern.base": PASSWORD_MESSAGE,
});

export const signupSchema = Joi.object({
  username: Joi.string().required(),
  email: Joi.string().trim().email().required(),
  password: strongPassword,
  name: Joi.string().trim().max(120).allow(""),
  // Optional for now so an older app build can still sign up (see AuthSvc.signup); when
  // present it can only be `true`.
  acceptedTerms: Joi.boolean().valid(true).optional(),
});

export const loginSchema = Joi.object({
  email: Joi.string().trim().email().required(),
  password: Joi.string().min(8).required(),
  remember: Joi.boolean().optional(),
});

export const updateRequiredPasswordSchema = Joi.object({
  email: Joi.string().trim().email().required(),
  currentPassword: Joi.string().required(),
  newPassword: strongPassword,
  remember: Joi.boolean().optional(),
});

export const googleLoginSchema = Joi.object({
  idToken: Joi.string().required(),
  remember: Joi.boolean().optional(),
  acceptedTerms: Joi.boolean().optional(),
});

export const googleLinkSchema = Joi.object({
  idToken: Joi.string().required(),
  password: Joi.string().required(),
  remember: Joi.boolean().optional(),
});

export const forgotPasswordSchema = Joi.object({
  email: Joi.string().trim().email().required(),
});

export const validateResetTokenSchema = Joi.object({
  token: Joi.string().required(),
});

export const resetPasswordSchema = Joi.object({
  token: Joi.string().required(),
  password: strongPassword,
});

export const sendOtpSchema = Joi.object({
  email: Joi.string().trim().email().required(),
});

export const cancelSignupSchema = Joi.object({
  email: Joi.string().trim().email().required(),
});

export const verifyOtpSchema = Joi.object({
  email: Joi.string().trim().email().required(),
  code: Joi.string().length(6).required(),
});

export const consumeLoginLinkSchema = Joi.object({
  token: Joi.string().required(),
});

// 32 random bytes, base64url — exactly 43 characters (see utils/handoff.ts).
export const consumeHandoffSchema = Joi.object({
  code: Joi.string().pattern(/^[A-Za-z0-9_-]{43}$/).required(),
});
