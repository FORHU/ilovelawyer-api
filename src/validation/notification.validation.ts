import Joi from "joi";

// Free-form like Event.type — new categories (e.g. a future "billing" alert) don't need a
// migration, but the bell UI only special-cases these three, so keep new values additive.
export const NOTIFICATION_TYPES = ["EVENT_REMINDER", "CASE_UPDATE", "SYSTEM"] as const;

export const listNotificationsSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).optional(),
  cursor: Joi.string().optional(),
  unreadOnly: Joi.boolean().truthy("true").falsy("false").optional(),
});

export const createNotificationSchema = Joi.object({
  userId: Joi.string().required(),
  organizationId: Joi.string().optional(),
  type: Joi.string()
    .valid(...NOTIFICATION_TYPES)
    .required(),
  title: Joi.string().trim().max(200).required(),
  message: Joi.string().trim().max(2000).required(),
  link: Joi.string().max(500).allow("").optional(),
});
