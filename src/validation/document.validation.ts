import Joi from "joi";
import { DOCUMENT_UPLOAD_BATCH_MAX } from "../constants";

export const presignDocumentSchema = Joi.alternatives().try(
  Joi.object({
    filename: Joi.string().required(),
    contentType: Joi.string().required(),
    caseId: Joi.string().optional(),
    consultationId: Joi.string().optional(),
  }),
  Joi.object({
    files: Joi.array()
      .items(
        Joi.object({
          filename: Joi.string().required(),
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
    name: Joi.string().required(),
    contentType: Joi.string().optional(),
    caseId: Joi.string().optional(),
    consultationId: Joi.string().optional(),
  }),
  Joi.object({
    items: Joi.array()
      .items(
        Joi.object({
          key: Joi.string().required(),
          name: Joi.string().required(),
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
});
