import Joi from "joi";
import { ALLOWED_DOCUMENT_EXTENSIONS, ALLOWED_DOCUMENT_FILENAME_PATTERN, DOCUMENT_UPLOAD_BATCH_MAX } from "../constants";

const UNSUPPORTED_FILE_TYPE_MESSAGE = `Unsupported file type. Supported formats: ${ALLOWED_DOCUMENT_EXTENSIONS.join(", ").toUpperCase()}.`;

const ACTION_TYPES = ["Civil Litigation", "Criminal Proceeding", "Labor Dispute", "Commercial Arbitration"];
const PARTY_DESIGNATIONS = ["Petitioner / Plaintiff", "Respondent / Defendant", "Intervenor / Third-Party"];
export const UK_JURISDICTIONS = ["England and Wales", "Scotland", "Northern Ireland"];

export const partySchema = Joi.object({
  name: Joi.string().required(),
  designation: Joi.string()
    .valid(...PARTY_DESIGNATIONS)
    .required(),
});

export const createCaseSchema = Joi.object({
  caseName: Joi.string().required(),
  partyInvolved: Joi.string().allow("").optional(),
  actionType: Joi.string()
    .valid(...ACTION_TYPES)
    .optional(),
  jurisdiction: Joi.string().allow("").optional(),
  ukJurisdiction: Joi.string()
    .valid(...UK_JURISDICTIONS)
    .optional(),
  notes: Joi.string().allow("").optional(),
  parties: Joi.array().items(partySchema).optional(),
});

export const listCasesSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  search: Joi.string().trim().allow("").optional(),
  status: Joi.string().valid("ACTIVE", "ARCHIVED").default("ACTIVE"),
});

export const updateCaseSchema = Joi.object({
  caseName: Joi.string().optional(),
  partyInvolved: Joi.string().allow("").optional(),
  actionType: Joi.string()
    .valid(...ACTION_TYPES)
    .optional(),
  jurisdiction: Joi.string().allow("").optional(),
  ukJurisdiction: Joi.string()
    .valid(...UK_JURISDICTIONS)
    .optional(),
  notes: Joi.string().allow("").optional(),
  parties: Joi.array().items(partySchema).optional(),
}).min(1);

export const createCaseWithDocumentSchema = Joi.object({
  caseId: Joi.string().required(),
  documentData: Joi.array()
    .min(1)
    .max(DOCUMENT_UPLOAD_BATCH_MAX)
    .items(
      Joi.object({
        filename: Joi.string()
          .required()
          .pattern(ALLOWED_DOCUMENT_FILENAME_PATTERN)
          .messages({ "string.pattern.base": UNSUPPORTED_FILE_TYPE_MESSAGE }),
        s3Key: Joi.string().required(),
        metaData: Joi.object({
          documentType: Joi.string().optional(),
          fileSize: Joi.number().integer().min(0).required(),
          mimeType: Joi.string().required(),
          category: Joi.string().trim().max(200).optional(),
        }).required(),
      }),
    )
    .required(),
});

export const relevantChunksSchema = Joi.object({
  query: Joi.string().trim().min(1).required(),
  limit: Joi.number().integer().min(1).max(100).default(20),
});
