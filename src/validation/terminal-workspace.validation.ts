import Joi from "joi";
import { PRESET_VALUES } from "../constants";

export const createWorkspaceSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).required(),
  preset: Joi.string()
    .valid(...PRESET_VALUES)
    .optional(),
  layoutJson: Joi.object().optional(),
});

export const updateWorkspaceSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).optional(),
  preset: Joi.string()
    .valid(...PRESET_VALUES)
    .optional(),
  layoutJson: Joi.object().optional(),
  isLastUsed: Joi.boolean().optional(),
}).min(1);

export const resetWorkspaceSchema = Joi.object({
  preset: Joi.string()
    .valid(...PRESET_VALUES)
    .optional(),
});
