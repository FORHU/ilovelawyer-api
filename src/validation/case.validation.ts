import Joi from "joi";
import { ALLOWED_DOCUMENT_EXTENSIONS, ALLOWED_DOCUMENT_FILENAME_PATTERN, DOCUMENT_UPLOAD_BATCH_MAX, BULK_ACTION_MAX, DOCUMENT_MAX_BYTES } from "../constants";

const UNSUPPORTED_FILE_TYPE_MESSAGE = `Unsupported file type. Supported formats: ${ALLOWED_DOCUMENT_EXTENSIONS.join(", ").toUpperCase()}.`;

const ACTION_TYPES = ["Civil Litigation", "Criminal Proceeding", "Labor Dispute", "Commercial Arbitration"];
const PARTY_DESIGNATIONS = ["Petitioner / Plaintiff", "Respondent / Defendant", "Intervenor / Third-Party"];
export const UK_JURISDICTIONS = ["England and Wales", "Scotland", "Northern Ireland"];
export const CLIENT_SIDES = ["CLAIMANT", "RESPONDENT"];
// Mirrored by the web app's case-field limits (lib/cases/limits.ts) — keep the two in step.
export const CASE_NAME_MAX_LENGTH = 150;
export const PARTY_NAME_MAX_LENGTH = 80;

const caseName = Joi.string()
  .trim()
  .max(CASE_NAME_MAX_LENGTH)
  .messages({ "string.max": `Case title must be ${CASE_NAME_MAX_LENGTH} characters or fewer.` });

export const partySchema = Joi.object({
  name: Joi.string()
    .trim()
    .max(PARTY_NAME_MAX_LENGTH)
    .required()
    .messages({ "string.max": `Party name must be ${PARTY_NAME_MAX_LENGTH} characters or fewer.` }),
  designation: Joi.string()
    .valid(...PARTY_DESIGNATIONS)
    .required(),
  // Lawyer-entered only (e.g. "Rep. by Hollis & Marr"); "" clears it.
  descriptor: Joi.string().trim().max(200).empty("").allow(null).optional(),
});

export const createCaseSchema = Joi.object({
  caseName: caseName.required(),
  partyInvolved: Joi.string().allow("").optional(),
  actionType: Joi.string()
    .valid(...ACTION_TYPES)
    .optional(),
  jurisdiction: Joi.string().allow("").optional(),
  ukJurisdiction: Joi.string()
    .valid(...UK_JURISDICTIONS)
    .optional(),
  clientSide: Joi.string()
    .valid(...CLIENT_SIDES)
    .allow(null)
    .optional(),
  notes: Joi.string().allow("").optional(),
  parties: Joi.array().items(partySchema).optional(),
});

export const listCasesSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  search: Joi.string().trim().allow("").optional(),
  status: Joi.string().valid("ACTIVE", "ARCHIVED").default("ACTIVE"),
  createdBy: Joi.string().uuid().optional(),
  // CaseListSort/CaseListOrder in case.repository.ts — Created, Last updated or Last opened.
  sort: Joi.string().valid("created", "updated", "opened").default("updated"),
  order: Joi.string().valid("asc", "desc").default("desc"),
});

export const updateCaseSchema = Joi.object({
  caseName: caseName.optional(),
  partyInvolved: Joi.string().allow("").optional(),
  actionType: Joi.string()
    .valid(...ACTION_TYPES)
    .optional(),
  jurisdiction: Joi.string().allow("").optional(),
  ukJurisdiction: Joi.string()
    .valid(...UK_JURISDICTIONS)
    .optional(),
  clientSide: Joi.string()
    .valid(...CLIENT_SIDES)
    .allow(null)
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
          fileSize: Joi.number().integer().min(0).max(DOCUMENT_MAX_BYTES).required(),
          mimeType: Joi.string().required(),
          category: Joi.string().trim().max(200).optional(),
        }).required(),
      }),
    )
    .required(),
});

/** Shared by the bulk archive, restore and delete endpoints — same {ids} shape for each. */
export const bulkCaseIdsSchema = Joi.object({
  ids: Joi.array().items(Joi.string()).min(1).max(BULK_ACTION_MAX).required(),
});

export const relevantChunksSchema = Joi.object({
  query: Joi.string().trim().min(1).required(),
  limit: Joi.number().integer().min(1).max(100).default(20),
});
