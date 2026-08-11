import { Request, Response } from "express";
import Joi from "joi";
import DocumentChunkSvc from "../services/document-chunk.service";
import HttpError from "../utils/http-error";

export default class DocumentChunkCtrl {
  static async list(req: Request, res: Response) {
    const schema = Joi.object({ caseDocumentId: Joi.string().required() });
    const { error, value } = schema.validate(req.params);
    if (error) throw new HttpError(error.message, 400);

    const result = await DocumentChunkSvc.listByDocument(value.caseDocumentId);
    return res.status(200).json(result);
  }
}
