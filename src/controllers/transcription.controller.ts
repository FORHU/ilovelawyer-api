import { workspaceOf } from "../utils/workspace";
import { Request, Response } from "express";
import TranscriptionSvc from "../services/transcription.service";
import ChatSvc from "../services/chat.service";
import HttpError from "../utils/http-error";
import { createTranscriptionSchema, updateTranscriptionSchema } from "../validation/transcription.validation";

export default class TranscriptionCtrl {
  static async list(req: Request, res: Response) {
    const { caseId } = req.query;

    if (caseId && typeof caseId === "string") {
      const items = await TranscriptionSvc.listByCase(workspaceOf(req), caseId, req.user.userId);
      return res.status(200).json(items);
    }

    const items = await TranscriptionSvc.list(workspaceOf(req), req.user.userId);
    return res.status(200).json(items);
  }

  static async getById(req: Request, res: Response) {
    const item = await TranscriptionSvc.getById(req.params.id, workspaceOf(req), req.user.userId);
    return res.status(200).json(item);
  }

  static async create(req: Request, res: Response) {
    const { error, value } = createTranscriptionSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    if (value.consultationId) {
      await ChatSvc.assertConsultationAccess(workspaceOf(req), req.user.userId, value.consultationId);
    }
    const item = await TranscriptionSvc.create(workspaceOf(req), req.user.userId, value);
    return res.status(201).json(item);
  }

  static async startJob(req: Request, res: Response) {
    const result = await TranscriptionSvc.startBatchJob(req.params.id, workspaceOf(req), req.user.userId);
    return res.status(200).json(result);
  }

  static async pollJob(req: Request, res: Response) {
    const result = await TranscriptionSvc.pollJobStatus(req.params.id, workspaceOf(req), req.user.userId);
    return res.status(200).json(result);
  }

  static async update(req: Request, res: Response) {
    const { error, value } = updateTranscriptionSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    if (value.consultationId) {
      await ChatSvc.assertConsultationAccess(workspaceOf(req), req.user.userId, value.consultationId);
    }
    const item = await TranscriptionSvc.update(req.params.id, workspaceOf(req), req.user.userId, value);
    return res.status(200).json(item);
  }

  static async delete(req: Request, res: Response) {
    await TranscriptionSvc.delete(req.params.id, workspaceOf(req), req.user.userId);
    return res.status(204).send();
  }

  static async chunk(req: Request, res: Response) {
    const result = await TranscriptionSvc.chunk(req.params.id, workspaceOf(req), req.user.userId);
    return res.status(200).json(result);
  }
}
