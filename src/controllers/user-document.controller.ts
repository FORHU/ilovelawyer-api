import { Request, Response } from "express";
import Joi from "joi";
import UserDocumentSvc from "../services/user-document.service";
import HttpError from "../utils/http-error";

export default class UserDocumentCtrl {
  static async upload(req: Request, res: Response) {
    if (!req.file) throw new HttpError("No file provided", 400);

    const { error, value } = Joi.object({ caseId: Joi.string().optional() }).validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const doc = await UserDocumentSvc.upload(req.user.userId, req.file, value.caseId);
    return res.status(201).json(doc);
  }

  static async list(req: Request, res: Response) {
    const { caseId } = req.query;

    if (caseId && typeof caseId === "string") {
      const docs = await UserDocumentSvc.listByCase(req.user.userId, caseId);
      return res.status(200).json(docs);
    }

    const docs = await UserDocumentSvc.list(req.user.userId);
    return res.status(200).json(docs);
  }

  static async getById(req: Request, res: Response) {
    const doc = await UserDocumentSvc.getById(req.params.id, req.user.userId);
    return res.status(200).json(doc);
  }

  static async update(req: Request, res: Response) {
    const schema = Joi.object({
      name: Joi.string().optional(),
      caseId: Joi.string().allow(null).optional(),
      aiSummary: Joi.string().optional(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    await UserDocumentSvc.update(req.params.id, req.user.userId, value);
    return res.status(204).send();
  }

  static async delete(req: Request, res: Response) {
    await UserDocumentSvc.delete(req.params.id, req.user.userId);
    return res.status(204).send();
  }
}
