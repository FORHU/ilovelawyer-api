import Joi from "joi";
import { GMAIL_SEARCH_MAX_LIMIT } from "../services/gmail-mailbox.service";

/** Gmail's own ids are short hex strings; page tokens are digits. Kept loose enough for either
 * and tight enough that nothing but an id can reach the Gmail URL. */
const GMAIL_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const connectGmailSchema = Joi.object({
  code: Joi.string().trim().max(2048).required(),
});

export const searchGmailSchema = Joi.object({
  /** Gmail search syntax, as typed in Gmail's own search box. Empty lists the whole inbox. */
  q: Joi.string().trim().allow("").max(500).default(""),
  pageToken: Joi.string().trim().max(256).pattern(/^[A-Za-z0-9_-]+$/),
  limit: Joi.number().integer().min(1).max(GMAIL_SEARCH_MAX_LIMIT).default(20),
});

export const gmailMessageParamsSchema = Joi.object({
  messageId: Joi.string().pattern(GMAIL_ID).required(),
});

/** A MIME part path such as "1" or "0.2.1". */
const PART_ID = Joi.string().max(32).pattern(/^\d+(\.\d+)*$/);

export const gmailAttachmentParamsSchema = Joi.object({
  messageId: Joi.string().pattern(GMAIL_ID).required(),
  partId: PART_ID.required(),
});

/** Add an email to a case (#986/#987): the email itself as a PDF, and/or chosen attachments. */
export const importGmailToCaseSchema = Joi.object({
  messageId: Joi.string().pattern(GMAIL_ID).required(),
  includeEmail: Joi.boolean().default(true),
  attachmentPartIds: Joi.array().items(PART_ID).max(25).default([]),
});
