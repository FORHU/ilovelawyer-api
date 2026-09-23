import { Request, Response } from "express";
import DocumentChunkSvc from "../services/document-chunk.service";
import { isDocumentInScope, filterDocumentsInScope } from "../services/case-document-callback-scope.service";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
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

    // The shared API key says who is calling, not whose document this is. Only ids handed to Chat
    // Wonder for a recent turn may be read back; anything else answers exactly like a missing
    // document, so the response does not confirm that such an id exists.
    if (!(await isDocumentInScope(params.caseDocumentId))) {
      throw new HttpError("Case document not found", 404);
    }

    logger.info("Case document: get requested", { caseDocumentId: params.caseDocumentId, query: queryParams.query });
    const result = await DocumentChunkSvc.listByDocument(params.caseDocumentId, queryParams.query);
    logger.info("Case document: get succeeded", { caseDocumentId: params.caseDocumentId, chunks: result.chunks.length, ragStatus: result.ragStatus });
    return res.status(200).json(result);
  }

  static async listByFilter(req: Request, res: Response) {
    const { error, value } = listChunksByFilterSchema.validate(req.query);
    if (error) throw new HttpError(error.message, 400);

    logger.info("Case document: list by filter requested", { caseId: value.caseId, consultationId: value.consultationId });
    const all = await DocumentChunkSvc.listByCaseOrConsultation(value);
    // Same rule as the by-id route: only documents handed to Chat Wonder for a recent turn.
    const result = await filterDocumentsInScope(all, (d) => d.caseDocumentId);
    logger.info("Case document: list by filter succeeded", {
      caseId: value.caseId,
      consultationId: value.consultationId,
      documents: result.length,
    });
    return res.status(200).json(result);
  }
}
