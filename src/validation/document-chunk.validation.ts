import Joi from "joi";

export const listChunksByDocumentSchema = Joi.object({ caseDocumentId: Joi.string().required() });

export const listChunksByFilterSchema = Joi.object({
  caseId: Joi.string(),
  consultationId: Joi.string(),
}).xor("caseId", "consultationId");
