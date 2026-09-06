import Joi from "joi";

export const createTranscriptionSchema = Joi.object({
  title: Joi.string().optional(),
  audioFileId: Joi.string().uuid().optional(),
  transcript: Joi.string().optional(),
  duration: Joi.number().optional(),
  caseId: Joi.string().allow(null).optional(),
  consultationId: Joi.string().allow(null).optional(),
});

export const updateTranscriptionSchema = Joi.object({
  title: Joi.string().optional(),
  transcript: Joi.string().optional(),
  duration: Joi.number().optional(),
  caseId: Joi.string().allow(null).optional(),
  consultationId: Joi.string().allow(null).optional(),
});
