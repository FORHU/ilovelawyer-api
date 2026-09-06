import Joi from "joi";

export const listConsultationsSchema = Joi.object({ caseId: Joi.string().guid().optional() });

export const createConsultationSchema = Joi.object({
  title: Joi.string().optional(),
  caseId: Joi.string().guid().optional(),
});

export const renameConsultationSchema = Joi.object({ title: Joi.string().required() });

export const relevantChunksSchema = Joi.object({
  query: Joi.string().trim().min(1).required(),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

export const sendMessageSchema = Joi.object({
  message: Joi.string().allow("").required(),
  sessionId: Joi.string().required(),
  documentContext: Joi.string().optional(),
  caseDocumentId: Joi.string().optional(),
  caseId: Joi.string().guid().optional(),
  documentIds: Joi.array().items(Joi.string()).optional(),
}).custom((value, helpers) => {
  // A file-only send (no typed text) is only valid when it's carrying at least one
  // attachment — otherwise there's nothing for the AI to respond to.
  if (!value.message.trim() && !value.documentIds?.length) {
    return helpers.message({ custom: '"message" must not be empty unless "documentIds" is provided' });
  }
  return value;
});
