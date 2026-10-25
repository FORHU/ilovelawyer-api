import Joi from "joi";
import {
  CLIENT_REQUEST_NOTE_MAX_LENGTH,
  CLIENT_REQUEST_QUOTE_MAX_MINOR,
  CLIENT_REQUEST_QUOTE_MESSAGE_MAX_LENGTH,
  CLIENT_REQUEST_RELEASE_NOTE_MAX_LENGTH,
  ENGAGEMENT_AI_TOP_UP_PACKS,
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

/** POST /client/lawyer-requests/:id/confirm. Not `valid(true)`: false gets its own
 * DISCLOSURE_NOT_ACKNOWLEDGED answer from the service. */
export const confirmClientRequestSchema = Joi.object({
  disclosureAcknowledged: Joi.boolean().required(),
});

/** POST /client/lawyer-requests/:id/decline. */
export const declineClientRequestSchema = Joi.object({
  reason: Joi.string().trim().allow("").max(500).optional(),
});

/** POST /client-requests/:id/close (lawyer) and /client/lawyer-requests/:id/end (client). */
export const closeClientRequestSchema = Joi.object({
  note: Joi.string().trim().allow("").max(1000).optional(),
});
export const endClientRequestSchema = Joi.object({
  reason: Joi.string().trim().allow("").max(1000).optional(),
});

/** POST /client-requests/:id/ai-top-ups (#516): which pack, and the lawyer's explicit approval of
 * the charge. Nothing is ever topped up without it. */
export const aiTopUpSchema = Joi.object({
  packId: Joi.string()
    .valid(...ENGAGEMENT_AI_TOP_UP_PACKS.map((p) => p.id))
    .required(),
  approved: Joi.boolean().valid(true).required().messages({ "any.only": "Approve the charge to buy a top-up." }),
});

/** POST /client/lawyer-requests/:id/feedback. */
export const feedbackClientRequestSchema = Joi.object({
  rating: Joi.number().integer().min(1).max(5).required(),
  comment: Joi.string().trim().allow("").max(2000).optional(),
});
