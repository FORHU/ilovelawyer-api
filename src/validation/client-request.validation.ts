import Joi from "joi";
import {
  CLIENT_REQUEST_NOTE_MAX_LENGTH,
  CLIENT_REQUEST_QUOTE_MAX_MINOR,
  CLIENT_REQUEST_QUOTE_MESSAGE_MAX_LENGTH,
  CLIENT_REQUEST_RELEASE_NOTE_MAX_LENGTH,
} from "../constants/client-request.constants";
import { QUOTE_TYPES, RELEASE_REASONS } from "../types/client-handoff";

export const createClientRequestSchema = Joi.object({
  caseId: Joi.string().uuid().required(),
  note: Joi.string().trim().allow("").max(CLIENT_REQUEST_NOTE_MAX_LENGTH).optional(),
  consentVersion: Joi.string().required(),
  // Not `valid(true)`: false gets its own CONSENT_REQUIRED answer from the service.
  consentAccepted: Joi.boolean().required(),
});

export const clientRequestEligibilitySchema = Joi.object({
  caseId: Joi.string().uuid().required(),
});

export const listClientRequestsSchema = Joi.object({
  caseId: Joi.string().uuid().optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

/** GET /client-requests: the lawyer app's inbox, the ones they hold, and the ones that ended. */
export const listLawyerClientRequestsSchema = Joi.object({
  view: Joi.string().valid("inbox", "mine", "history").default("inbox"),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

/** POST /client-requests/:id/release: why the lawyer is giving it back. */
export const releaseClientRequestSchema = Joi.object({
  reason: Joi.string()
    .valid(...RELEASE_REASONS)
    .required(),
  note: Joi.string().trim().allow("").max(CLIENT_REQUEST_RELEASE_NOTE_MAX_LENGTH).optional(),
});

/** POST /client-requests/:id/quote. GBP only: client requests are UK only. A first consultation may
 * be free (0); the service refuses a fixed fee of 0. */
export const quoteClientRequestSchema = Joi.object({
  type: Joi.string()
    .valid(...QUOTE_TYPES)
    .required(),
  amount: Joi.object({
    amountMinor: Joi.number().integer().min(0).max(CLIENT_REQUEST_QUOTE_MAX_MINOR).required(),
    currency: Joi.string().valid("GBP").required(),
  }).required(),
  message: Joi.string().trim().min(1).max(CLIENT_REQUEST_QUOTE_MESSAGE_MAX_LENGTH).required(),
});
