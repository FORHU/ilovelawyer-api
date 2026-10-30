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

/** POST /client/lawyer-requests/:id/confirm. Not `valid(true)`: false gets its own
 * DISCLOSURE_NOT_ACKNOWLEDGED answer from the service. */
export const confirmClientRequestSchema = Joi.object({
  disclosureAcknowledged: Joi.boolean().required(),
  // Several lawyers: whose quote (LawyerRequestForClient.lawyers[].claimId). Optional when there's one.
  claimId: Joi.string().trim().optional(),
});

/** POST /client/lawyer-requests/:id/decline. */
export const declineClientRequestSchema = Joi.object({
  reason: Joi.string().trim().allow("").max(500).optional(),
  claimId: Joi.string().trim().optional(),
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
  // Which packs exist is the tenant's (LawyerPricingSvc): an unknown one is refused when buying.
  packId: Joi.string().trim().min(1).max(32).required(),
  approved: Joi.boolean().valid(true).required().messages({ "any.only": "Approve the charge to buy a top-up." }),
});

/** POST /client/lawyer-requests/:id/feedback. */
export const feedbackClientRequestSchema = Joi.object({
  rating: Joi.number().integer().min(1).max(5).required(),
  comment: Joi.string().trim().allow("").max(2000).optional(),
});

/** GET /client-requests/:id/messages and /client/lawyer-requests/:id/messages (#517): oldest first.
 * The client names the lawyer's thread with `claimId` (one per lawyer since phase 5b); left out, it's
 * the hired lawyer's. The lawyer has one thread per request, so they never send it. */
export const listEngagementMessagesSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(100),
  claimId: Joi.string().uuid().optional(),
});

/** POST /client/lawyer-requests/:id/messages and .../messages/read: which lawyer's thread, as above. */
export const engagementThreadSchema = Joi.object({
  claimId: Joi.string().uuid().optional(),
});

/** POST .../messages (#517). The lawyer sends text; the client may also share a case document, once
 * that lawyer is hired. */
export const postEngagementMessageSchema = Joi.object({
  body: Joi.string().trim().allow("").max(5000).optional(),
  documentId: Joi.string().uuid().optional(),
});
