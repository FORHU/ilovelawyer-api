import Joi from "joi";

export const analyzeLegalSourceSchema = Joi.object({ keyword: Joi.string().required() });
