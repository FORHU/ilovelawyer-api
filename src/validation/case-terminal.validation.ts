import Joi from "joi";

const RISK_SEVERITIES = ["FATAL", "MAJOR", "UNVERIFIED", "MISSING_EVIDENCE", "DEADLINE"];
const RISK_STATUSES = ["OPEN", "CONFIRMED", "ACCEPTED"];
const TIMELINE_SOURCES = ["AI", "LAWYER", "CALENDAR"];
const FINDING_CATEGORIES = ["LEGAL_ISSUE", "WEAKNESS", "STRENGTH", "ATTACK_STRATEGY", "DEFENSE_STRATEGY"];
const DAMAGE_CATEGORIES = ["ACTUAL", "MORAL", "EXEMPLARY", "ATTORNEYS_FEES", "OTHER"];
const PRIVILEGE_STATUSES = ["NONE", "ATTORNEY_CLIENT", "WORK_PRODUCT"];
const HEARSAY_CATEGORIES = [
  "DIRECT_EVIDENCE",
  "BUSINESS_RECORD",
  "PRESENT_SENSE_IMPRESSION",
  "EXCITED_UTTERANCE",
  "OTHER_EXCEPTION",
  "NOT_APPLICABLE",
];
const CASE_EDGE_RELATION_TYPES = ["SUPPORTS", "CONTRADICTS", "CITES", "PROVES", "REFUTES", "SPONSORS"];
const GRAPH_VIEW_TYPES = ["timeline", "witnesses", "contradictions", "issues"];

export const createTimelineSchema = Joi.object({
  title: Joi.string().required(),
  occurredOn: Joi.date().iso().optional().allow(null),
  description: Joi.string().allow("").optional(),
  status: Joi.string().valid("completed", "pending", "active").optional(),
  source: Joi.string()
    .valid(...TIMELINE_SOURCES)
    .optional(),
  documentId: Joi.string().optional().allow(null),
  chunkId: Joi.string().optional().allow(null),
  pageNumber: Joi.number().integer().min(1).optional().allow(null),
});

export const updateTimelineSchema = Joi.object({
  title: Joi.string().optional(),
  occurredOn: Joi.date().iso().optional().allow(null),
  description: Joi.string().allow("").optional(),
  status: Joi.string().valid("completed", "pending", "active").optional(),
  source: Joi.string()
    .valid(...TIMELINE_SOURCES)
    .optional(),
  documentId: Joi.string().optional().allow(null),
  chunkId: Joi.string().optional().allow(null),
  pageNumber: Joi.number().integer().min(1).optional().allow(null),
}).min(1);

export const createRiskSchema = Joi.object({
  title: Joi.string().required(),
  description: Joi.string().allow("").optional(),
  severity: Joi.string()
    .valid(...RISK_SEVERITIES)
    .required(),
  status: Joi.string()
    .valid(...RISK_STATUSES)
    .optional(),
  ownerUserId: Joi.string().optional().allow(null),
  documentId: Joi.string().optional().allow(null),
  chunkId: Joi.string().optional().allow(null),
  pageNumber: Joi.number().integer().min(1).optional().allow(null),
});

export const updateRiskSchema = Joi.object({
  title: Joi.string().optional(),
  description: Joi.string().allow("").optional(),
  severity: Joi.string()
    .valid(...RISK_SEVERITIES)
    .optional(),
  status: Joi.string()
    .valid(...RISK_STATUSES)
    .optional(),
  ownerUserId: Joi.string().optional().allow(null),
  documentId: Joi.string().optional().allow(null),
  chunkId: Joi.string().optional().allow(null),
  pageNumber: Joi.number().integer().min(1).optional().allow(null),
}).min(1);

export const upsertMatrixSchema = Joi.object({
  authenticity: Joi.string().optional(),
  admissibility: Joi.string().optional(),
  probative: Joi.string().optional(),
  originalFile: Joi.boolean().optional(),
  needsVerify: Joi.boolean().optional(),
  notes: Joi.string().allow("").optional(),
  privilegeStatus: Joi.string()
    .valid(...PRIVILEGE_STATUSES)
    .optional(),
  hearsayCategory: Joi.string()
    .valid(...HEARSAY_CATEGORIES)
    .optional(),
  sponsoringWitnessId: Joi.string().optional().allow(null),
}).min(1);

export const addCustodyEventSchema = Joi.object({
  custodianName: Joi.string().required(),
  action: Joi.string().required(),
  occurredAt: Joi.date().iso().required(),
  notes: Joi.string().allow("").optional(),
});

export const checkCitationSchema = Joi.object({
  quotedText: Joi.string().required(),
  citedReference: Joi.string().optional(),
  sourceUrl: Joi.string().optional(),
  officialText: Joi.string().optional(),
  legalRagId: Joi.string().optional(),
  pinpoint: Joi.string().optional(),
});

export const createDeadlineSchema = Joi.object({
  ruleCode: Joi.string().required(),
  triggerDate: Joi.string().required(),
  serviceMethod: Joi.string().optional(),
  sourceTimelineEventId: Joi.string().optional(),
});

export const confirmDeadlineSchema = Joi.object({
  confirmed: Joi.boolean().required(),
  note: Joi.string().optional(),
});

export const createProcedureItemSchema = Joi.object({
  kind: Joi.string().required(),
  label: Joi.string().required(),
  notes: Joi.string().optional(),
});

export const updateProcedureItemSchema = Joi.object({
  done: Joi.boolean().optional(),
  notes: Joi.string().optional(),
  label: Joi.string().optional(),
}).min(1);

export const grantAccessSchema = Joi.object({
  userId: Joi.string().required(),
  permission: Joi.string().valid("VIEW", "EDIT", "ADMIN").required(),
});

export const listFindingsSchema = Joi.object({ category: Joi.string().valid(...FINDING_CATEGORIES).optional() });

export const createFindingSchema = Joi.object({
  category: Joi.string()
    .valid(...FINDING_CATEGORIES)
    .required(),
  label: Joi.string().required(),
  notes: Joi.string().allow("").optional(),
});

export const updateFindingSchema = Joi.object({
  label: Joi.string().optional(),
  notes: Joi.string().allow("").optional(),
}).min(1);

export const createWitnessSchema = Joi.object({
  name: Joi.string().required(),
  role: Joi.string().allow("").optional(),
  contact: Joi.string().allow("").optional(),
  notes: Joi.string().allow("").optional(),
});

export const updateWitnessSchema = Joi.object({
  name: Joi.string().optional(),
  role: Joi.string().allow("").optional(),
  contact: Joi.string().allow("").optional(),
  notes: Joi.string().allow("").optional(),
}).min(1);

export const createDamageSchema = Joi.object({
  category: Joi.string()
    .valid(...DAMAGE_CATEGORIES)
    .required(),
  description: Joi.string().allow("").optional(),
  amount: Joi.number().min(0).optional().allow(null),
});

export const updateDamageSchema = Joi.object({
  category: Joi.string()
    .valid(...DAMAGE_CATEGORIES)
    .optional(),
  description: Joi.string().allow("").optional(),
  amount: Joi.number().min(0).optional().allow(null),
}).min(1);

export const createClaimSchema = Joi.object({
  title: Joi.string().required(),
  causeOfAction: Joi.string().allow("").optional(),
  description: Joi.string().allow("").optional(),
});

export const updateClaimSchema = Joi.object({
  title: Joi.string().optional(),
  causeOfAction: Joi.string().allow("").optional(),
  description: Joi.string().allow("").optional(),
}).min(1);

export const updateReconstructionSchema = Joi.object({
  narrative: Joi.string().optional(),
  narrativeCourt: Joi.string().allow("").optional(),
  narrativeOpposing: Joi.string().allow("").optional(),
}).min(1);

export const createCaseEdgeSchema = Joi.object({
  sourceEntityId: Joi.string().required(),
  targetEntityId: Joi.string().required(),
  relationType: Joi.string()
    .valid(...CASE_EDGE_RELATION_TYPES)
    .required(),
  metadata: Joi.object().optional(),
});

export const graphViewSchema = Joi.object({
  view_type: Joi.string()
    .valid(...GRAPH_VIEW_TYPES)
    .required(),
});
