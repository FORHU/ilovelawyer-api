import Joi from "joi";
import { LAWYER_COUNTRIES } from "../constants/lawyer-application.constants";
import { PRACTICE_AREA_NAME_MAX_LENGTH } from "../constants/practice-area.constants";

const country = Joi.string().valid(...LAWYER_COUNTRIES);
const name = Joi.string().trim().min(1).max(PRACTICE_AREA_NAME_MAX_LENGTH);
// A CaseArea code; CaseAreaSvc.assertMappable checks it exists, and refuses one on PH.
const caseArea = Joi.string().max(40).allow(null);

export const practiceAreaListSchema = Joi.object({ country: country.required() });

export const createPracticeAreaSchema = Joi.object({
  country: country.required(),
  name: name.required(),
  caseArea,
});

export const updatePracticeAreaSchema = Joi.object({
  name,
  caseArea,
  isActive: Joi.boolean().strict(),
}).min(1);

export const reorderPracticeAreasSchema = Joi.object({
  country: country.required(),
  ids: Joi.array().items(Joi.string().min(1)).min(1).unique().required(),
});
