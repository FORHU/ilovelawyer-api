import Joi from "joi";
import { ALLOWED_DOCUMENT_EXTENSIONS, ALLOWED_DOCUMENT_FILENAME_PATTERN, DOCUMENT_UPLOAD_BATCH_MAX } from "../constants";

const UNSUPPORTED_FILE_TYPE_MESSAGE = `Unsupported file type. Supported formats: ${ALLOWED_DOCUMENT_EXTENSIONS.join(", ").toUpperCase()}.`;

const allowedFilename = Joi.string()
  .required()
  .pattern(ALLOWED_DOCUMENT_FILENAME_PATTERN)
  .messages({ "string.pattern.base": UNSUPPORTED_FILE_TYPE_MESSAGE });

export const presignDocumentSchema = Joi.alternatives().try(
  Joi.object({
    filename: allowedFilename,
    contentType: Joi.string().required(),
    caseId: Joi.string().optional(),
    consultationId: Joi.string().optional(),
  }),
  Joi.object({
    files: Joi.array()
      .items(
        Joi.object({
          filename: allowedFilename,
          contentType: Joi.string().required(),
        }),
      )
      .min(1)
      .max(DOCUMENT_UPLOAD_BATCH_MAX)
      .required(),
    caseId: Joi.string().optional(),
    consultationId: Joi.string().optional(),
  }),
);

export const createDocumentSchema = Joi.alternatives().try(
  Joi.object({
    key: Joi.string().required(),
    name: allowedFilename,
    contentType: Joi.string().optional(),
    caseId: Joi.string().optional(),
    consultationId: Joi.string().optional(),
  }),
  Joi.object({
    items: Joi.array()
      .items(
        Joi.object({
          key: Joi.string().required(),
          name: allowedFilename,
          contentType: Joi.string().optional(),
        }),
      )
      .min(1)
      .max(DOCUMENT_UPLOAD_BATCH_MAX)
      .required(),
    caseId: Joi.string().optional(),
    consultationId: Joi.string().optional(),
  }),
);

export const updateDocumentSchema = Joi.object({
  name: Joi.string().optional(),
  caseId: Joi.string().allow(null).optional(),
  consultationId: Joi.string().allow(null).optional(),
  isExhibit: Joi.boolean().optional(),
});
