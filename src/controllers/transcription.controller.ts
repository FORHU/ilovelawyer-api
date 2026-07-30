import { Request, Response } from "express";
import Joi from "joi";
import TranscriptionSvc from "../services/transcription.service";
import HttpError from "../utils/http-error";

const createSchema = Joi.object({
  title: Joi.string().optional(),
  audioFileId: Joi.string().uuid().optional(),
  transcript: Joi.string().optional(),
  duration: Joi.number().optional(),
  caseId: Joi.string().optional(),
});

const updateSchema = Joi.object({
  title: Joi.string().optional(),
  transcript: Joi.string().optional(),
  duration: Joi.number().optional(),
  caseId: Joi.string().allow(null).optional(),
});

export default class TranscriptionCtrl {
  static async list(req: Request, res: Response) {
    const { caseId } = req.query;

    if (caseId && typeof caseId === "string") {
      const items = await TranscriptionSvc.listByCase(req.user.userId, caseId);
      return res.status(200).json(items);
    }

    const items = await TranscriptionSvc.list(req.user.userId);
    return res.status(200).json(items);
  }

  static async getById(req: Request, res: Response) {
    const item = await TranscriptionSvc.getById(req.params.id, req.user.userId);
    return res.status(200).json(item);
  }

  static async create(req: Request, res: Response) {
    const { error, value } = createSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const item = await TranscriptionSvc.create(req.user.userId, value);
    return res.status(201).json(item);
  }

  static async startJob(req: Request, res: Response) {
    const result = await TranscriptionSvc.startBatchJob(req.params.id, req.user.userId);
    return res.status(200).json(result);
  }

  static async pollJob(req: Request, res: Response) {
    const result = await TranscriptionSvc.pollJobStatus(req.params.id, req.user.userId);
    return res.status(200).json(result);
  }

  static async update(req: Request, res: Response) {
    const { error, value } = updateSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const item = await TranscriptionSvc.update(req.params.id, req.user.userId, value);
    return res.status(200).json(item);
  }

  static async delete(req: Request, res: Response) {
    await TranscriptionSvc.delete(req.params.id, req.user.userId);
    return res.status(204).send();
  }
}
