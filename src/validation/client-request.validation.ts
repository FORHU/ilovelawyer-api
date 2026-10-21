import Joi from "joi";
import { CLIENT_REQUEST_NOTE_MAX_LENGTH } from "../constants/client-request.constants";

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
