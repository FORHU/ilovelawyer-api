import { Request, Response } from "express";
import DocumentChunkSvc from "../services/document-chunk.service";
import HttpError from "../utils/http-error";
import {
  listChunksByDocumentSchema,
  listChunksByDocumentQuerySchema,
  listChunksByFilterSchema,
} from "../validation/document-chunk.validation";

export default class DocumentChunkCtrl {
  static async list(req: Request, res: Response) {
    const { error: paramsError, value: params } = listChunksByDocumentSchema.validate(req.params);
    if (paramsError) throw new HttpError(paramsError.message, 400);

    const { error: queryError, value: queryParams } = listChunksByDocumentQuerySchema.validate(req.query);
    if (queryError) throw new HttpError(queryError.message, 400);

    const result = await DocumentChunkSvc.listByDocument(params.caseDocumentId, queryParams.query);
    return res.status(200).json(result);
  }

  static async listByFilter(req: Request, res: Response) {
    const { error, value } = listChunksByFilterSchema.validate(req.query);
    if (error) throw new HttpError(error.message, 400);

    const result = await DocumentChunkSvc.listByCaseOrConsultation(value);
    return res.status(200).json(result);
  }
}
