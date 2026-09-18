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
  email: Joi.string().email().required(),
  password: strongPassword,
  name: Joi.string().trim().max(120).allow(""),
});

export const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
  remember: Joi.boolean().optional(),
});

export const updateRequiredPasswordSchema = Joi.object({
  email: Joi.string().email().required(),
  currentPassword: Joi.string().required(),
  newPassword: strongPassword,
  remember: Joi.boolean().optional(),
});

export const googleLoginSchema = Joi.object({
  idToken: Joi.string().required(),
  remember: Joi.boolean().optional(),
});

export const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().required(),
});

export const validateResetTokenSchema = Joi.object({
  token: Joi.string().required(),
});

export const resetPasswordSchema = Joi.object({
  token: Joi.string().required(),
  password: strongPassword,
});

export const sendOtpSchema = Joi.object({
  email: Joi.string().email().required(),
});

export const cancelSignupSchema = Joi.object({
  email: Joi.string().email().required(),
});

export const verifyOtpSchema = Joi.object({
  email: Joi.string().email().required(),
  code: Joi.string().length(6).required(),
});

export const consumeLoginLinkSchema = Joi.object({
  token: Joi.string().required(),
});
