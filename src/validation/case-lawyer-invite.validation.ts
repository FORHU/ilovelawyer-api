import Joi from "joi";

/** GET /client/lawyer-invites, and POST .../link and .../revoke: which case. */
export const caseLawyerInviteCaseSchema = Joi.object({
  caseId: Joi.string().uuid().required(),
});

/** POST /client/lawyer-invites/email: the case, and the lawyer's email to send the invite to. */
export const createEmailInviteSchema = Joi.object({
  caseId: Joi.string().uuid().required(),
  email: Joi.string().email().required(),
});
