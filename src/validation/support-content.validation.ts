import Joi from "joi";
import { SUPPORT_ACTION_KEYS } from "../constants/support-actions.constants";

export const SUPPORT_CONTENT_LIMITS = {
  flows: 100,
  stepsPerFlow: 60,
  triggersPerFlow: 40,
  triggerLength: 60,
  optionsPerStep: 10,
  menuCards: 12,
  textLength: 1500,
  titleLength: 120,
} as const;

const L = SUPPORT_CONTENT_LIMITS;
const id = Joi.string().trim().min(1).max(80);
const text = Joi.string().trim().min(1).max(L.textLength);
const title = Joi.string().trim().min(1).max(L.titleLength);

const target = Joi.alternatives().try(
  Joi.object({ kind: Joi.string().valid("STEP").required(), stepId: id.required() }),
  Joi.object({ kind: Joi.string().valid("FLOW").required(), flowId: id.required() }),
  Joi.object({ kind: Joi.string().valid("LINK").required(), href: Joi.string().trim().max(500).required(), label: title }),
  Joi.object({ kind: Joi.string().valid("TALK_TO_PERSON").required() }),
  Joi.object({ kind: Joi.string().valid("END").required() }),
);

const step = Joi.alternatives().try(
  Joi.object({ id: id.required(), type: Joi.string().valid("MESSAGE").required(), text: text.required(), next: target }),
  Joi.object({
    id: id.required(),
    type: Joi.string().valid("CHOICES").required(),
    text,
    style: Joi.string().valid("BUTTONS", "QUICK_REPLIES").required(),
    options: Joi.array().items(Joi.object({ label: title.required(), target: target.required() })).min(1).max(L.optionsPerStep).required(),
  }),
  Joi.object({
    id: id.required(),
    type: Joi.string().valid("ACTION").required(),
    actionKey: Joi.string().valid(...SUPPORT_ACTION_KEYS).required(),
    onSuccess: target.required(),
    onFailure: target.required(),
  }),
  Joi.object({ id: id.required(), type: Joi.string().valid("DID_THAT_HELP").required() }),
);

const flow = Joi.object({
  id: id.required(),
  title: title.required(),
  audience: Joi.string().valid("SIGNED_IN", "SIGNED_OUT", "BOTH").required(),
  triggers: Joi.array().items(Joi.string().trim().min(1).max(L.triggerLength)).max(L.triggersPerFlow).required(),
  relatedFlowIds: Joi.array().items(id).max(10).required(),
  startStepId: id.required(),
  steps: Joi.object().pattern(id, step).min(1).max(L.stepsPerFlow).required(),
});

const menuCard = Joi.object({
  id: id.required(),
  title: title.required(),
  subtitle: Joi.string().trim().max(200).allow(""),
  flowId: id.required(),
  enabled: Joi.boolean().strict().required(),
});

export const supportContentSchema = Joi.object({
  schemaVersion: Joi.number().valid(1).required(),
  settings: Joi.object({
    assistantName: title.required(),
    avatarUrl: Joi.string().trim().max(500).allow(null).required(),
    greeting: text.required(),
    responseTimeLine: text.required(),
  }).required(),
  menus: Joi.object({
    SIGNED_IN: Joi.array().items(menuCard).max(L.menuCards).required(),
    SIGNED_OUT: Joi.array().items(menuCard).max(L.menuCards).required(),
  }).required(),
  flows: Joi.object().pattern(id, flow).max(L.flows).required(),
});

export const updateSupportDraftSchema = Joi.object({
  content: supportContentSchema.required(),
  expectedUpdatedAt: Joi.string().isoDate().required(),
});

export const supportVersionParamSchema = Joi.object({ version: Joi.number().integer().min(1).required() });
