import Joi from "joi";
import {
  ALLOWED_DOCUMENT_EXTENSIONS,
  ALLOWED_DOCUMENT_FILENAME_PATTERN,
  DOCUMENT_UPLOAD_BATCH_MAX,
  DOCUMENT_UPLOAD_BATCH_MAX_BYTES,
  BULK_ACTION_MAX,
} from "../constants";

const UNSUPPORTED_FILE_TYPE_MESSAGE = `Unsupported file type. Supported formats: ${ALLOWED_DOCUMENT_EXTENSIONS.join(", ").toUpperCase()}.`;

const allowedFilename = Joi.string()
  .required()
  .pattern(ALLOWED_DOCUMENT_FILENAME_PATTERN)
  .messages({ "string.pattern.base": UNSUPPORTED_FILE_TYPE_MESSAGE });

/** Bytes of one file. No per-file cap beyond the batch limit itself (one file can't exceed the
 * whole upload); zero-byte files are allowed. Optional until every web client sends it — see
 * the presign schema. */
const fileSize = Joi.number().integer().min(0).max(DOCUMENT_UPLOAD_BATCH_MAX_BYTES);

export const presignDocumentSchema = Joi.alternatives().try(
  Joi.object({
    filename: allowedFilename,
    contentType: Joi.string().required(),
    // Signed into the upload URL when sent, so S3 rejects a PUT of any other size. Optional
    // until the web release that sends it is deployed and verified; then make it required.
    fileSize: fileSize.optional(),
    caseId: Joi.string().optional(),
    consultationId: Joi.string().optional(),
  }),
  Joi.object({
    files: Joi.array()
      .items(
        Joi.object({
          filename: allowedFilename,
          contentType: Joi.string().required(),
          fileSize: fileSize.optional(),
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
    fileSize: fileSize.optional(),
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
          fileSize: fileSize.optional(),
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

export const listDocumentsSchema = Joi.object({
  caseId: Joi.string().optional(),
  consultationId: Joi.string().optional(),
  status: Joi.string().valid("ACTIVE", "ARCHIVED").default("ACTIVE"),
});

/** Shared by the bulk archive, restore and delete endpoints — same {ids} shape for each. */
export const bulkDocumentIdsSchema = Joi.object({
  ids: Joi.array().items(Joi.string()).min(1).max(BULK_ACTION_MAX).required(),
});
