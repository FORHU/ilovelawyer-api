import { Request, Response } from "express";
import Joi from "joi";
import DocumentSvc from "../services/document.service";
import HttpError from "../utils/http-error";

export default class DocumentCtrl {
  static async presign(req: Request, res: Response) {
    const schema = Joi.object({
      filename: Joi.string().required(),
      contentType: Joi.string().required(),
      caseId: Joi.string().optional(),
      consultationId: Joi.string().optional(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const result = await DocumentSvc.presign(
      req.user.userId,
      value.filename,
      value.contentType,
      value.caseId,
      value.consultationId
    );
    return res.status(200).json(result);
  }

  static async create(req: Request, res: Response) {
    const schema = Joi.alternatives().try(
      Joi.object({
        key: Joi.string().required(),
        name: Joi.string().required(),
        contentType: Joi.string().optional(),
        caseId: Joi.string().optional(),
        consultationId: Joi.string().optional(),
      }),
      Joi.object({
        items: Joi.array()
          .items(
            Joi.object({
              key: Joi.string().required(),
              name: Joi.string().required(),
              contentType: Joi.string().optional(),
            }),
          )
          .min(1)
          .required(),
        caseId: Joi.string().optional(),
        consultationId: Joi.string().optional(),
      }),
    );
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    if (value.items) {
      const docs = await DocumentSvc.createMany(
        req.organization!.id,
        req.user.userId,
        value.items,
        value.caseId,
        value.consultationId,
      );
      return res.status(201).json(docs);
    }

    const doc = await DocumentSvc.create(req.organization!.id, req.user.userId, value);
    return res.status(201).json(doc);
  }

  static async list(req: Request, res: Response) {
    const { caseId, consultationId } = req.query;

    if (caseId && typeof caseId === "string") {
      const docs = await DocumentSvc.listByCase(req.organization!.id, caseId);
      return res.status(200).json(docs);
    }

    if (consultationId && typeof consultationId === "string") {
      const docs = await DocumentSvc.listByConsultation(req.organization!.id, consultationId);
      return res.status(200).json(docs);
    }

    const docs = await DocumentSvc.list(req.organization!.id);
    return res.status(200).json(docs);
  }

  static async getById(req: Request, res: Response) {
    const doc = await DocumentSvc.getById(req.params.id, req.organization!.id);
    return res.status(200).json(doc);
  }

  static async update(req: Request, res: Response) {
    const schema = Joi.object({
      name: Joi.string().optional(),
      caseId: Joi.string().allow(null).optional(),
      consultationId: Joi.string().allow(null).optional(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    await DocumentSvc.update(req.params.id, req.organization!.id, value);
    return res.status(204).send();
  }

  static async delete(req: Request, res: Response) {
    await DocumentSvc.delete(req.params.id, req.organization!.id);
    return res.status(204).send();
  }
}
