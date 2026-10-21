import Joi from "joi";
import { ALLOWED_DOCUMENT_EXTENSIONS, ALLOWED_DOCUMENT_FILENAME_PATTERN, DOCUMENT_UPLOAD_BATCH_MAX_BYTES } from "../constants";
import {
  CLIENT_CASE_AREAS,
  CLIENT_CASE_TITLE_MAX_LENGTH,
  CLIENT_CASE_WHERE_MAX_LENGTH,
  CLIENT_MESSAGE_MAX_LENGTH,
  CLIENT_PARTY_ROLES,
} from "../constants/client-case.constants";
import { CLIENT_SIDES, PARTY_NAME_MAX_LENGTH, UK_JURISDICTIONS } from "./case.validation";

const filename = Joi.string()
  .required()
  .pattern(ALLOWED_DOCUMENT_FILENAME_PATTERN)
  .messages({ "string.pattern.base": `Unsupported file type. Supported formats: ${ALLOWED_DOCUMENT_EXTENSIONS.join(", ").toUpperCase()}.` });
const fileSize = Joi.number().integer().min(0).max(DOCUMENT_UPLOAD_BATCH_MAX_BYTES);

export const createClientCaseSchema = Joi.object({
  paymentId: Joi.string().required(),
  title: Joi.string().trim().min(1).max(CLIENT_CASE_TITLE_MAX_LENGTH).required(),
  area: Joi.string()
    .valid(...CLIENT_CASE_AREAS)
    .required(),
  // null: it happened outside the UK. The client still gets the AI, but no lawyer for now.
  ukJurisdiction: Joi.string()
    .valid(...UK_JURISDICTIONS)
    .allow(null)
    .required(),
  where: Joi.string().trim().allow("").max(CLIENT_CASE_WHERE_MAX_LENGTH).optional(),
  side: Joi.string()
    .valid(...CLIENT_SIDES)
    .allow(null)
    .optional(),
  others: Joi.array()
    .items(
      Joi.object({
        name: Joi.string().trim().min(1).max(PARTY_NAME_MAX_LENGTH).required(),
        role: Joi.string()
          .valid(...CLIENT_PARTY_ROLES)
          .required(),
      }),
    )
    .max(20)
    .optional(),
});

// Asks the dummy payment provider to decline, to test the app's failure screen. A real provider
// ignores it.
const testOutcome = Joi.string().valid("decline").optional();

export const quoteClientCaseSchema = Joi.object({
  promoCode: Joi.string().trim().allow("").max(40).optional(),
});

export const payForClientCaseSchema = Joi.object({
  promoCode: Joi.string().trim().allow("").max(40).optional(),
  testOutcome,
});

export const topUpClientCaseSchema = Joi.object({
  packId: Joi.string().required(),
  testOutcome,
});

export const sendClientMessageSchema = Joi.object({
  text: Joi.string().trim().min(1).max(CLIENT_MESSAGE_MAX_LENGTH).required(),
});

export const presignClientDocumentSchema = Joi.object({
  filename,
  contentType: Joi.string().required(),
  fileSize: fileSize.optional(),
});

export const addClientDocumentSchema = Joi.object({
  key: Joi.string().required(),
  name: filename,
  contentType: Joi.string().optional(),
  fileSize: fileSize.optional(),
});
