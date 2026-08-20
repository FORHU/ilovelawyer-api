import { Request, Response } from "express";
import Joi from "joi";
import CaseSnapshotSvc from "../services/case-snapshot.service";
import CaseTimelineSvc from "../services/case-timeline.service";
import CaseRiskSvc from "../services/case-risk.service";
import CaseRefreshSvc from "../services/case-refresh.service";
import EvidenceIntelligenceSvc from "../services/evidence-intelligence.service";
import CitationCheckSvc from "../services/citation-check.service";
import ProceduralDeadlineSvc from "../services/procedural-deadline.service";
import OrganizationSvc from "../services/organization.service";
import HttpError from "../utils/http-error";

const RISK_SEVERITIES = ["FATAL", "MAJOR", "UNVERIFIED", "MISSING_EVIDENCE", "DEADLINE"];
const RISK_STATUSES = ["OPEN", "CONFIRMED", "ACCEPTED"];
const TIMELINE_SOURCES = ["AI", "LAWYER", "CALENDAR"];

export default class CaseTerminalCtrl {
  static async snapshot(req: Request, res: Response) {
    const result = await CaseSnapshotSvc.get(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }

  static async refresh(req: Request, res: Response) {
    const result = await CaseRefreshSvc.refresh(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }

  static async listTimeline(req: Request, res: Response) {
    const result = await CaseTimelineSvc.list(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }

  static async createTimeline(req: Request, res: Response) {
    const schema = Joi.object({
      title: Joi.string().required(),
      occurredOn: Joi.date().iso().optional().allow(null),
      description: Joi.string().allow("").optional(),
      status: Joi.string().valid("completed", "pending", "active").optional(),
      source: Joi.string().valid(...TIMELINE_SOURCES).optional(),
      documentId: Joi.string().optional().allow(null),
      chunkId: Joi.string().optional().allow(null),
      pageNumber: Joi.number().integer().min(1).optional().allow(null),
    });
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await CaseTimelineSvc.create(req.params.caseId, req.user.userId, value);
    return res.status(201).json(result);
  }

  static async updateTimeline(req: Request, res: Response) {
    const schema = Joi.object({
      title: Joi.string().optional(),
      occurredOn: Joi.date().iso().optional().allow(null),
      description: Joi.string().allow("").optional(),
      status: Joi.string().valid("completed", "pending", "active").optional(),
      source: Joi.string().valid(...TIMELINE_SOURCES).optional(),
      documentId: Joi.string().optional().allow(null),
      chunkId: Joi.string().optional().allow(null),
      pageNumber: Joi.number().integer().min(1).optional().allow(null),
    }).min(1);
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await CaseTimelineSvc.update(req.params.caseId, req.params.id, req.user.userId, value);
    return res.status(200).json(result);
  }

  static async deleteTimeline(req: Request, res: Response) {
    await CaseTimelineSvc.delete(req.params.caseId, req.params.id, req.user.userId);
    return res.status(204).send();
  }

  static async listRisks(req: Request, res: Response) {
    const result = await CaseRiskSvc.list(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }

  static async createRisk(req: Request, res: Response) {
    const schema = Joi.object({
      title: Joi.string().required(),
      description: Joi.string().allow("").optional(),
      severity: Joi.string().valid(...RISK_SEVERITIES).required(),
      status: Joi.string().valid(...RISK_STATUSES).optional(),
      ownerUserId: Joi.string().optional().allow(null),
      documentId: Joi.string().optional().allow(null),
      chunkId: Joi.string().optional().allow(null),
      pageNumber: Joi.number().integer().min(1).optional().allow(null),
    });
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await CaseRiskSvc.create(req.params.caseId, req.user.userId, value);
    return res.status(201).json(result);
  }

  static async updateRisk(req: Request, res: Response) {
    const schema = Joi.object({
      title: Joi.string().optional(),
      description: Joi.string().allow("").optional(),
      severity: Joi.string().valid(...RISK_SEVERITIES).optional(),
      status: Joi.string().valid(...RISK_STATUSES).optional(),
      ownerUserId: Joi.string().optional().allow(null),
      documentId: Joi.string().optional().allow(null),
      chunkId: Joi.string().optional().allow(null),
      pageNumber: Joi.number().integer().min(1).optional().allow(null),
    }).min(1);
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await CaseRiskSvc.update(req.params.caseId, req.params.id, req.user.userId, value);
    return res.status(200).json(result);
  }

  static async deleteRisk(req: Request, res: Response) {
    await CaseRiskSvc.delete(req.params.caseId, req.params.id, req.user.userId);
    return res.status(204).send();
  }

  static async evidence(req: Request, res: Response) {
    const result = await EvidenceIntelligenceSvc.list(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }

  static async upsertMatrix(req: Request, res: Response) {
    const schema = Joi.object({
      authenticity: Joi.string().optional(),
      admissibility: Joi.string().optional(),
      probative: Joi.string().optional(),
      originalFile: Joi.boolean().optional(),
      needsVerify: Joi.boolean().optional(),
      notes: Joi.string().allow("").optional(),
    }).min(1);
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await EvidenceIntelligenceSvc.upsertMatrix(
      req.params.caseId,
      req.user.userId,
      req.params.documentId,
      value,
    );
    return res.status(200).json(result);
  }

  static async scanContradictions(req: Request, res: Response) {
    const result = await EvidenceIntelligenceSvc.scanContradictions(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }

  static async traces(req: Request, res: Response) {
    const result = await EvidenceIntelligenceSvc.traces(req.params.caseId, req.user.userId, req.params.documentId);
    return res.status(200).json(result);
  }

  static async listCitations(req: Request, res: Response) {
    const result = await CitationCheckSvc.list(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }

  static async checkCitation(req: Request, res: Response) {
    const schema = Joi.object({
      quotedText: Joi.string().required(),
      citedReference: Joi.string().optional(),
      sourceUrl: Joi.string().optional(),
      officialText: Joi.string().optional(),
      legalRagId: Joi.string().optional(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await CitationCheckSvc.check(req.params.caseId, req.user.userId, value);
    return res.status(201).json(result);
  }

  static async procedureRules(_req: Request, res: Response) {
    return res.status(200).json(ProceduralDeadlineSvc.rules());
  }

  static async procedure(req: Request, res: Response) {
    const result = await ProceduralDeadlineSvc.list(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }

  static async createDeadline(req: Request, res: Response) {
    const schema = Joi.object({
      ruleCode: Joi.string().required(),
      triggerDate: Joi.string().required(),
      serviceMethod: Joi.string().optional(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await ProceduralDeadlineSvc.create(req.params.caseId, req.user.userId, value);
    return res.status(201).json(result);
  }

  static async confirmDeadline(req: Request, res: Response) {
    const schema = Joi.object({
      confirmed: Joi.boolean().required(),
      note: Joi.string().optional(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await ProceduralDeadlineSvc.confirm(
      req.params.caseId,
      req.params.deadlineId,
      req.user.userId,
      value.confirmed,
      value.note,
    );
    return res.status(200).json(result);
  }

  static async createProcedureItem(req: Request, res: Response) {
    const schema = Joi.object({
      kind: Joi.string().required(),
      label: Joi.string().required(),
      notes: Joi.string().optional(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await ProceduralDeadlineSvc.createItem(req.params.caseId, req.user.userId, value);
    return res.status(201).json(result);
  }

  static async updateProcedureItem(req: Request, res: Response) {
    const schema = Joi.object({
      done: Joi.boolean().optional(),
      notes: Joi.string().optional(),
      label: Joi.string().optional(),
    }).min(1);
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await ProceduralDeadlineSvc.updateItem(req.params.caseId, req.params.id, req.user.userId, value);
    return res.status(200).json(result);
  }

  static async teamAudit(req: Request, res: Response) {
    const result = await OrganizationSvc.teamAudit(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }

  static async grantAccess(req: Request, res: Response) {
    const schema = Joi.object({
      userId: Joi.string().required(),
      permission: Joi.string().valid("VIEW", "EDIT", "ADMIN").required(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await OrganizationSvc.grantAccess(req.params.caseId, req.user.userId, value.userId, value.permission);
    return res.status(201).json(result);
  }
}
