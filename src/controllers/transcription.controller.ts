import { Request, Response } from "express";
import TranscriptionSvc from "../services/transcription.service";
import HttpError from "../utils/http-error";
import { createTranscriptionSchema, updateTranscriptionSchema } from "../validation/transcription.validation";

export default class TranscriptionCtrl {
  static async list(req: Request, res: Response) {
    const { caseId } = req.query;

    if (caseId && typeof caseId === "string") {
      const items = await TranscriptionSvc.listByCase(req.organization!.id, caseId);
      return res.status(200).json(items);
    }

    const items = await TranscriptionSvc.list(req.organization!.id);
    return res.status(200).json(items);
  }

  static async getById(req: Request, res: Response) {
    const item = await TranscriptionSvc.getById(req.params.id, req.organization!.id);
    return res.status(200).json(item);
  }

  static async create(req: Request, res: Response) {
    const { error, value } = createTranscriptionSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const item = await TranscriptionSvc.create(req.organization!.id, req.user.userId, value);
    return res.status(201).json(item);
  }

  static async startJob(req: Request, res: Response) {
    const result = await TranscriptionSvc.startBatchJob(req.params.id, req.organization!.id);
    return res.status(200).json(result);
  }

  static async pollJob(req: Request, res: Response) {
    const result = await TranscriptionSvc.pollJobStatus(req.params.id, req.organization!.id);
    return res.status(200).json(result);
  }

  static async update(req: Request, res: Response) {
    const { error, value } = updateTranscriptionSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const item = await TranscriptionSvc.update(req.params.id, req.organization!.id, value);
    return res.status(200).json(item);
  }

  static async delete(req: Request, res: Response) {
    await TranscriptionSvc.delete(req.params.id, req.organization!.id);
    return res.status(204).send();
  }

  static async chunk(req: Request, res: Response) {
    const result = await TranscriptionSvc.chunk(req.params.id, req.organization!.id);
    return res.status(200).json(result);
  }
}
