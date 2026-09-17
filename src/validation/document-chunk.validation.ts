import Joi from "joi";

export const listChunksByDocumentSchema = Joi.object({ caseDocumentId: Joi.string().required() });

// query, when present, BM25-ranks the document's chunks by relevance to it before returning
// them — see DocumentChunkSvc.listByDocument. Reordering only; nothing is dropped.
export const listChunksByDocumentQuerySchema = Joi.object({ query: Joi.string().allow("").optional() });

export const listChunksByFilterSchema = Joi.object({
  caseId: Joi.string(),
  consultationId: Joi.string(),
}).xor("caseId", "consultationId");
