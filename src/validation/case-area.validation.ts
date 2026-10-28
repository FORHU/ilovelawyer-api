import Joi from "joi";
import { LAWYER_COUNTRIES } from "../constants/lawyer-application.constants";
import { CASE_AREA_DESCRIPTION_MAX_LENGTH, CASE_AREA_NAME_MAX_LENGTH } from "../constants/case-area.constants";

const country = Joi.string().valid(...LAWYER_COUNTRIES);
const name = Joi.string().trim().min(1).max(CASE_AREA_NAME_MAX_LENGTH);
const description = Joi.string().trim().min(1).max(CASE_AREA_DESCRIPTION_MAX_LENGTH);

export const caseAreaListSchema = Joi.object({ country: country.required() });

// CaseAreaSvc checks the code's shape (CASE_AREA_CODE_PATTERN) after upper-casing it.
export const createCaseAreaSchema = Joi.object({
  country: country.required(),
  code: Joi.string().trim().min(2).max(40).required(),
  name: name.required(),
  description: description.required(),
});

// No `code`: cases and practice areas hold it, so it's fixed once made.
export const updateCaseAreaSchema = Joi.object({
  name,
  description,
  isActive: Joi.boolean().strict(),
}).min(1);

export const reorderCaseAreasSchema = Joi.object({
  country: country.required(),
  ids: Joi.array().items(Joi.string().min(1)).min(1).unique().required(),
});
