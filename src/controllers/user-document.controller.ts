import { Request, Response } from "express";
import Joi from "joi";
import UserDocumentSvc from "../services/user-document.service";
import HttpError from "../utils/http-error";

export default class UserDocumentCtrl {
  static async presign(req: Request, res: Response) {
    const schema = Joi.object({
      filename: Joi.string().required(),
      contentType: Joi.string().required(),
      caseId: Joi.string().optional(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const result = await UserDocumentSvc.presign(req.user.userId, value.filename, value.contentType, value.caseId);
    return res.status(200).json(result);
  }

  static async create(req: Request, res: Response) {
    const schema = Joi.object({
      key: Joi.string().required(),
      name: Joi.string().required(),
      caseId: Joi.string().optional(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const doc = await UserDocumentSvc.create(req.user.userId, value);
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
