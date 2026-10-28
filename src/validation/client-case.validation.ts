import Joi from "joi";
import { ALLOWED_DOCUMENT_EXTENSIONS, ALLOWED_DOCUMENT_FILENAME_PATTERN, DOCUMENT_UPLOAD_BATCH_MAX_BYTES } from "../constants";
import {
  CLIENT_CASE_NOTES_MAX_LENGTH,
  CLIENT_CASE_TITLE_MAX_LENGTH,
  CLIENT_CASE_WHERE_MAX_LENGTH,
  CLIENT_MESSAGE_DOCUMENTS_MAX,
  CLIENT_MESSAGE_MAX_LENGTH,
  CLIENT_PARTY_ROLES,
} from "../constants/client-case.constants";
import { CLIENT_SIDES, PARTY_NAME_MAX_LENGTH, UK_JURISDICTIONS } from "./case.validation";

const filename = Joi.string()
  .required()
  .pattern(ALLOWED_DOCUMENT_FILENAME_PATTERN)
  .messages({ "string.pattern.base": `Unsupported file type. Supported formats: ${ALLOWED_DOCUMENT_EXTENSIONS.join(", ").toUpperCase()}.` });
const fileSize = Joi.number().integer().min(0).max(DOCUMENT_UPLOAD_BATCH_MAX_BYTES);

const otherParties = Joi.array()
  .items(
    Joi.object({
      name: Joi.string().trim().min(1).max(PARTY_NAME_MAX_LENGTH).required(),
      role: Joi.string()
        .valid(...CLIENT_PARTY_ROLES)
        .required(),
    }),
  )
  .max(20);

const notes = Joi.string().trim().allow("").max(CLIENT_CASE_NOTES_MAX_LENGTH);

// CaseArea codes, one or more; CaseAreaSvc.forCase checks them against the site's list. `area` (one
// code) is what the app sent before a case could have several; still taken, as a list of one.
const areas = Joi.array().items(Joi.string().max(40)).min(1).unique();
const area = Joi.string().max(40);

export const createClientCaseSchema = Joi.object({
  paymentId: Joi.string().required(),
  title: Joi.string().trim().min(1).max(CLIENT_CASE_TITLE_MAX_LENGTH).required(),
  areas,
  area,
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
  others: otherParties.optional(),
  notes: notes.optional(),
}).xor("areas", "area");

/** Editing a case: any of the details the wizard asked for, but at least one. */
export const updateClientCaseSchema = Joi.object({
  title: Joi.string().trim().min(1).max(CLIENT_CASE_TITLE_MAX_LENGTH),
  areas,
  area,
  ukJurisdiction: Joi.string()
    .valid(...UK_JURISDICTIONS)
    .allow(null),
  where: Joi.string().trim().allow("").max(CLIENT_CASE_WHERE_MAX_LENGTH),
  side: Joi.string()
    .valid(...CLIENT_SIDES)
    .allow(null),
  others: otherParties,
  notes,
})
  .min(1)
  .oxor("areas", "area");

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
  // The case's documents to send with it. Repeats are folded in ClientCaseSvc.sendMessage.
  documentIds: Joi.array().items(Joi.string().trim().min(1)).max(CLIENT_MESSAGE_DOCUMENTS_MAX).optional(),
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
