import Joi from "joi";

export const createEventSchema = Joi.object({
  title: Joi.string().trim().optional(),
  type: Joi.string().trim().optional(),
  date_time: Joi.date().iso().optional(),
  dateTime: Joi.date().iso().optional(),
  client_email: Joi.string().email({ tlds: false }).allow("").optional(),
  clientEmail: Joi.string().email({ tlds: false }).allow("").optional(),
  notes: Joi.string().allow("").optional(),
  status: Joi.string().optional(),
  google_link: Joi.string().uri().allow("").optional(),
  google_event_id: Joi.string().optional(),
  caseId: Joi.string().optional(),
  case_id: Joi.string().optional(),
  dateSource: Joi.string().optional(),
  date_source: Joi.string().optional(),
  reminderLeadMinutes: Joi.number().integer().positive().optional(),
  reminder_lead_minutes: Joi.number().integer().positive().optional(),
})
  .or("date_time", "dateTime")
  .messages({ "object.missing": '"date_time" (or "dateTime") is required' });

export const updateEventSchema = Joi.object({
  title: Joi.string().trim().optional(),
  type: Joi.string().trim().optional(),
  date_time: Joi.date().iso().optional(),
  dateTime: Joi.date().iso().optional(),
  client_email: Joi.string().email({ tlds: false }).allow("").optional(),
  clientEmail: Joi.string().email({ tlds: false }).allow("").optional(),
  notes: Joi.string().allow("").optional(),
  status: Joi.string().optional(),
  google_link: Joi.string().uri().allow("").optional(),
  google_event_id: Joi.string().optional(),
  caseId: Joi.string().allow(null).optional(),
  case_id: Joi.string().allow(null).optional(),
  dateSource: Joi.string().optional(),
  date_source: Joi.string().optional(),
  reminderLeadMinutes: Joi.number().integer().positive().allow(null).optional(),
  reminder_lead_minutes: Joi.number().integer().positive().allow(null).optional(),
  last_reminder_sent_at: Joi.date().iso().optional(),
  lawyer_acknowledged_at: Joi.date().iso().optional(),
}).min(1);

export const updateEventByGoogleIdSchema = Joi.object({
  status: Joi.string().optional(),
  google_link: Joi.string().uri().allow("").optional(),
  title: Joi.string().trim().optional(),
  type: Joi.string().trim().optional(),
  date_time: Joi.date().iso().optional(),
  dateTime: Joi.date().iso().optional(),
  client_email: Joi.string().email({ tlds: false }).allow("").optional(),
  clientEmail: Joi.string().email({ tlds: false }).allow("").optional(),
  notes: Joi.string().allow("").optional(),
}).min(1);
