import Joi from "joi";
import { MIND_MAP_LIMITS } from "../constants/mind-map-limits.constants";

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

// Mind map expand/undo (MindMapSvc). messageId picks a specific message's map; without it the
// consultation's active (newest) map is used. nodeId is a path id ("legalBasis.2") — or, for a map
// saved before ids were normalized, the model's own id, which the service still resolves.
export const expandMindMapNodeSchema = Joi.object({
  messageId: Joi.string().guid().optional(),
  nodeId: Joi.string().trim().min(1).max(200).required(),
  count: Joi.number().integer().min(MIND_MAP_LIMITS.expandMin).max(MIND_MAP_LIMITS.expandMax).optional(),
});

export const revertMindMapSchema = Joi.object({
  messageId: Joi.string().guid().optional(),
  /** The version the client is looking at — a stale undo is refused instead of undoing a newer change. */
  version: Joi.number().integer().min(1).optional(),
});

// A manual edit on a map (MindMapSvc.editNode): rename a node, add a point under it, or delete it.
const mindMapLabel = Joi.string().trim().min(1).max(120);
const mindMapDescription = Joi.string().trim().allow("").max(2000);
export const editMindMapNodeSchema = Joi.object({
  messageId: Joi.string().guid().optional(),
  op: Joi.string().valid("add", "rename", "delete").required(),
  nodeId: Joi.string().trim().min(1).max(200).required(),
  label: Joi.when("op", { is: "delete", then: Joi.forbidden(), otherwise: mindMapLabel.required() }),
  description: Joi.when("op", { is: "delete", then: Joi.forbidden(), otherwise: mindMapDescription.optional() }),
});

// The same actions on the case's document-built map (CaseMindMapCtrl) — no messageId, a case
// has exactly one.
export const expandCaseMindMapNodeSchema = expandMindMapNodeSchema.fork(["messageId"], (s) => s.forbidden());
export const revertCaseMindMapSchema = revertMindMapSchema.fork(["messageId"], (s) => s.forbidden());
export const editCaseMindMapNodeSchema = editMindMapNodeSchema.fork(["messageId"], (s) => s.forbidden());
