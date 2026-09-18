import Joi from "joi";

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
