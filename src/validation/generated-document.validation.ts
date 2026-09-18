import Joi from "joi";

export const createGeneratedDocumentSchema = Joi.object({
  documentName: Joi.string().required(),
  content: Joi.string().required(),
  format: Joi.string().valid("docx", "pdf").default("docx"),
});
