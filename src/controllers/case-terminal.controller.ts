import { Request, Response } from "express";
import CaseSnapshotSvc from "../services/case-snapshot.service";
import CaseTimelineSvc from "../services/case-timeline.service";
import CaseRiskSvc from "../services/case-risk.service";
import CaseRefreshSvc from "../services/case-refresh.service";
import EvidenceIntelligenceSvc from "../services/evidence-intelligence.service";
import CitationCheckSvc from "../services/citation-check.service";
import CitationMapSvc from "../services/citation-map.service";
import UkCitationMapSvc from "../services/uk-citation-map.service";
import ProceduralDeadlineSvc from "../services/procedural-deadline.service";
import OrganizationSvc from "../services/organization.service";
import CaseFindingSvc from "../services/case-finding.service";
import WitnessSvc from "../services/witness.service";
import DamageClaimSvc from "../services/damage-claim.service";
import CaseReconstructionSvc from "../services/case-reconstruction.service";
import CaseReconstructionAudioSvc from "../services/case-reconstruction-audio.service";
import CaseReconstructionAudioQueue from "../queues/case-reconstruction-audio.queue";
import RedTeamSvc from "../services/red-team.service";
import AiGenerationLockSvc from "../services/ai-generation-lock.service";
import { AI_GENERATION_KINDS, AiGenerationKind } from "../constants";
import HttpError from "../utils/http-error";
import { FindingCategory } from "@prisma/client";
import { getTenantContext } from "../utils/tenant-context";
import {
  createTimelineSchema,
  updateTimelineSchema,
  createRiskSchema,
  updateRiskSchema,
  upsertMatrixSchema,
  addCustodyEventSchema,
  checkCitationSchema,
  createDeadlineSchema,
  confirmDeadlineSchema,
  createProcedureItemSchema,
  updateProcedureItemSchema,
  grantAccessSchema,
  listFindingsSchema,
  createFindingSchema,
  updateFindingSchema,
  createWitnessSchema,
  updateWitnessSchema,
  createDamageSchema,
  updateDamageSchema,
  updateReconstructionSchema,
} from "../validation/case-terminal.validation";

export default class CaseTerminalCtrl {
  static async snapshot(req: Request, res: Response) {
    const result = await CaseSnapshotSvc.get(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }

  static async refresh(req: Request, res: Response) {
    const result = await CaseRefreshSvc.refresh(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }

  /** GET /api/my-cases/:caseId/ai-jobs/:kind — polled by every case-scoped Generate/Refresh/
   * Scan button so a page load can tell "already running" from "idle" regardless of who
   * triggered it or when (see AiGenerationJob). Citation Map's PH/UK expand has its own
   * existing status endpoint instead (GET /api/law/:lawId/citations) — not scoped by caseId. */
  static async getAiJobStatus(req: Request, res: Response) {
    const kind = req.params.kind as string;
    if (!(AI_GENERATION_KINDS as readonly string[]).includes(kind)) {
      throw new HttpError(`Unknown AI generation kind: ${kind}`, 400);
    }
    const result = await AiGenerationLockSvc.getStatusForCase(req.params.caseId, req.user.userId, kind as AiGenerationKind);
    return res.status(200).json(result);
  }

  static async listTimeline(req: Request, res: Response) {
    const result = await CaseTimelineSvc.list(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }

  static async createTimeline(req: Request, res: Response) {
    const { error, value } = createTimelineSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await CaseTimelineSvc.create(req.params.caseId, req.user.userId, value);
    return res.status(201).json(result);
  }

  static async updateTimeline(req: Request, res: Response) {
    const { error, value } = updateTimelineSchema.validate(req.body);
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
    const { error, value } = createRiskSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await CaseRiskSvc.create(req.params.caseId, req.user.userId, value);
    return res.status(201).json(result);
  }

  static async updateRisk(req: Request, res: Response) {
    const { error, value } = updateRiskSchema.validate(req.body);
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
    const { error, value } = upsertMatrixSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await EvidenceIntelligenceSvc.upsertMatrix(
      req.params.caseId,
      req.user.userId,
      req.params.documentId,
      value,
    );
    return res.status(200).json(result);
  }

  static async addCustodyEvent(req: Request, res: Response) {
    const { error, value } = addCustodyEventSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await EvidenceIntelligenceSvc.addCustodyEvent(
      req.params.caseId,
      req.user.userId,
      req.params.documentId,
      value,
    );
    return res.status(201).json(result);
  }

  static async deleteCustodyEvent(req: Request, res: Response) {
    await EvidenceIntelligenceSvc.deleteCustodyEvent(
      req.params.caseId,
      req.user.userId,
      req.params.documentId,
      req.params.eventId,
    );
    return res.status(204).send();
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

  /** Citation Map covers PH (juris.ph) and UK (UK Legal MCP) — every other tenantCode gets a
   * 501, same defense-in-depth pattern as LawCtrl.search; the frontend gates the panel the same
   * way via config/tenant-codes. */
  static async citationMap(req: Request, res: Response) {
    const { tenantCode } = getTenantContext(req);
    if (tenantCode !== "PH" && tenantCode !== "UK") {
      throw new HttpError("Citation Map is not available for this jurisdiction — coming soon", 501);
    }
    const result =
      tenantCode === "UK"
        ? await UkCitationMapSvc.getSeed(req.params.caseId, req.user.userId)
        : await CitationMapSvc.getSeed(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }

  static async checkCitation(req: Request, res: Response) {
    const { error, value } = checkCitationSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await CitationCheckSvc.check(req.params.caseId, req.user.userId, value);
    return res.status(201).json(result);
  }

  static async procedureRules(req: Request, res: Response) {
    const { tenantCode } = getTenantContext(req);
    return res.status(200).json(ProceduralDeadlineSvc.rules(tenantCode));
  }

  static async procedure(req: Request, res: Response) {
    const result = await ProceduralDeadlineSvc.list(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }

  static async createDeadline(req: Request, res: Response) {
    const { error, value } = createDeadlineSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await ProceduralDeadlineSvc.create(req.params.caseId, req.user.userId, value);
    return res.status(201).json(result);
  }

  static async recomputeDeadline(req: Request, res: Response) {
    const result = await ProceduralDeadlineSvc.recompute(req.params.caseId, req.params.deadlineId, req.user.userId);
    return res.status(200).json(result);
  }

  static async confirmDeadline(req: Request, res: Response) {
    const { error, value } = confirmDeadlineSchema.validate(req.body);
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
    const { error, value } = createProcedureItemSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await ProceduralDeadlineSvc.createItem(req.params.caseId, req.user.userId, value);
    return res.status(201).json(result);
  }

  static async updateProcedureItem(req: Request, res: Response) {
    const { error, value } = updateProcedureItemSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await ProceduralDeadlineSvc.updateItem(req.params.caseId, req.params.id, req.user.userId, value);
    return res.status(200).json(result);
  }

  static async teamAudit(req: Request, res: Response) {
    const result = await OrganizationSvc.teamAudit(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }

  static async grantAccess(req: Request, res: Response) {
    const { error, value } = grantAccessSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await OrganizationSvc.grantAccess(req.params.caseId, req.user.userId, value.userId, value.permission);
    return res.status(201).json(result);
  }

  static async listFindings(req: Request, res: Response) {
    const { error, value } = listFindingsSchema.validate(req.query);
    if (error) throw new HttpError(error.message, 400);
    const result = await CaseFindingSvc.list(req.params.caseId, req.user.userId, value.category as FindingCategory | undefined);
    return res.status(200).json(result);
  }

  static async createFinding(req: Request, res: Response) {
    const { error, value } = createFindingSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await CaseFindingSvc.create(req.params.caseId, req.user.userId, value);
    return res.status(201).json(result);
  }

  static async updateFinding(req: Request, res: Response) {
    const { error, value } = updateFindingSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await CaseFindingSvc.update(req.params.caseId, req.params.id, req.user.userId, value);
    return res.status(200).json(result);
  }

  static async deleteFinding(req: Request, res: Response) {
    await CaseFindingSvc.delete(req.params.caseId, req.params.id, req.user.userId);
    return res.status(204).send();
  }

  static async listWitnesses(req: Request, res: Response) {
    const result = await WitnessSvc.list(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }

  static async createWitness(req: Request, res: Response) {
    const { error, value } = createWitnessSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await WitnessSvc.create(req.params.caseId, req.user.userId, value);
    return res.status(201).json(result);
  }

  static async updateWitness(req: Request, res: Response) {
    const { error, value } = updateWitnessSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await WitnessSvc.update(req.params.caseId, req.params.id, req.user.userId, value);
    return res.status(200).json(result);
  }

  static async deleteWitness(req: Request, res: Response) {
    await WitnessSvc.delete(req.params.caseId, req.params.id, req.user.userId);
    return res.status(204).send();
  }

  static async listDamages(req: Request, res: Response) {
    const result = await DamageClaimSvc.list(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }

  static async createDamage(req: Request, res: Response) {
    const { error, value } = createDamageSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await DamageClaimSvc.create(req.params.caseId, req.user.userId, value);
    return res.status(201).json(result);
  }

  static async updateDamage(req: Request, res: Response) {
    const { error, value } = updateDamageSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await DamageClaimSvc.update(req.params.caseId, req.params.id, req.user.userId, value);
    return res.status(200).json(result);
  }

  static async deleteDamage(req: Request, res: Response) {
    await DamageClaimSvc.delete(req.params.caseId, req.params.id, req.user.userId);
    return res.status(204).send();
  }

  static async getReconstruction(req: Request, res: Response) {
    const result = await CaseReconstructionSvc.get(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }

  static async generateReconstruction(req: Request, res: Response) {
    const result = await CaseReconstructionSvc.generate(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }

  static async updateReconstruction(req: Request, res: Response) {
    const { error, value } = updateReconstructionSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await CaseReconstructionSvc.update(req.params.caseId, req.user.userId, value);
    return res.status(200).json(result);
  }

  static async generateReconstructionAudio(req: Request, res: Response) {
    const result = await CaseReconstructionAudioSvc.startAudioJob(req.params.caseId, req.user.userId);
    // Poll to completion server-side too — same queue case-post-extraction.ts's auto-generation
    // uses — so it finishes even if nobody keeps this case's audio panel open to poll it.
    CaseReconstructionAudioQueue.enqueue(req.params.caseId);
    return res.status(202).json(result);
  }

  static async pollReconstructionAudio(req: Request, res: Response) {
    const result = await CaseReconstructionAudioSvc.pollAudioJob(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }

  static async getRedTeam(req: Request, res: Response) {
    const result = await RedTeamSvc.get(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }

  static async generateRedTeam(req: Request, res: Response) {
    const result = await RedTeamSvc.generate(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }
}
