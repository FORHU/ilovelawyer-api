import { Request, Response } from "express";
import CaseMindMapSvc from "../services/case-mind-map.service";
import MindMapSvc from "../services/mind-map.service";
import AiGenerationLockSvc from "../services/ai-generation-lock.service";
import AiGenerationQueue from "../queues/ai-generation.queue";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { editCaseMindMapNodeSchema, expandCaseMindMapNodeSchema, revertCaseMindMapSchema } from "../validation/chat.validation";

/** The case's document-built mind map (CaseMindMapSvc) — what Studio's Mind Map panel shows.
 * The chat-generated per-consultation maps have their own endpoints under /chat/consultations. */
export default class CaseMindMapCtrl {
  /** GET /api/my-cases/:caseId/mind-map — null (200) until the case's first build. */
  static async get(req: Request, res: Response) {
    const map = await CaseMindMapSvc.get(req.params.caseId, req.user.userId);
    return res.status(200).json(map);
  }

  /** POST /api/my-cases/:caseId/mind-map/generate — Studio's Regenerate. Queued via
   * AiGenerationQueue like timeline generate; the client follows ai-jobs/caseMindMap. */
  static async generate(req: Request, res: Response) {
    const { caseId } = req.params;
    const userId = req.user.userId;
    logger.info("Case mind map generate: requested", { caseId, userId });
    await CaseMindMapSvc.beginQueuedGenerate(caseId, userId);
    AiGenerationQueue.enqueue({ kind: "caseMindMapGenerate", caseId, userId });
    return res.status(202).json(await AiGenerationLockSvc.getStatus(caseId, "caseMindMap"));
  }

  static async expand(req: Request, res: Response) {
    const { error, value } = expandCaseMindMapNodeSchema.validate(req.body, { convert: true });
    if (error) throw new HttpError(error.message, 400);
    const result = await MindMapSvc.expandCaseNode({
      userId: req.user.userId,
      caseId: req.params.caseId,
      nodeId: value.nodeId,
      count: value.count,
    });
    return res.status(200).json(result);
  }

  /** PATCH /api/my-cases/:caseId/mind-map — a manual rename / add / delete (MindMapSvc.editCaseNode). */
  static async edit(req: Request, res: Response) {
    const { error, value } = editCaseMindMapNodeSchema.validate(req.body, { convert: true });
    if (error) throw new HttpError(error.message, 400);
    const result = await MindMapSvc.editCaseNode({ userId: req.user.userId, caseId: req.params.caseId, edit: value });
    return res.status(200).json(result);
  }

  static async revert(req: Request, res: Response) {
    const { error, value } = revertCaseMindMapSchema.validate(req.body, { convert: true });
    if (error) throw new HttpError(error.message, 400);
    const result = await MindMapSvc.revertCaseMap({
      userId: req.user.userId,
      caseId: req.params.caseId,
      expectedVersion: value.version,
    });
    return res.status(200).json(result);
  }
}
