import { Request, Response } from "express";
import CaseSvc from "../services/case.service";
import DocumentChunkSvc from "../services/document-chunk.service";
import HttpError from "../utils/http-error";
import { PartyInput } from "../repositories/case.repository";
import { IncomingCaseDocument } from "../types/case.types";
import { normalizeCaseBody } from "../utils/case.utils";
import {
  createCaseSchema,
  listCasesSchema,
  updateCaseSchema,
  createCaseWithDocumentSchema,
  relevantChunksSchema,
  bulkCaseIdsSchema,
} from "../validation/case.validation";

export default class CaseCtrl {
  static async create(req: Request, res: Response) {
    const { error, value } = createCaseSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const result = await CaseSvc.create(req.organization!.id, req.user.userId, normalizeCaseBody(value) as {
      caseName: string;
      actionType?: string;
      jurisdiction?: string;
      ukJurisdiction?: string;
      notes?: string;
      parties?: PartyInput[];
    });
    return res.status(201).json(result);
  }

  static async list(req: Request, res: Response) {
    const { error, value } = listCasesSchema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const result = await CaseSvc.list(req.organization!.id, value.page, value.limit, value.search, value.status);
    return res.status(200).json(result);
  }

  static async getById(req: Request, res: Response) {
    const result = await CaseSvc.getById(req.params.id, req.organization!.id);
    return res.status(200).json(result);
  }

  static async update(req: Request, res: Response) {
    const { error, value } = updateCaseSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const result = await CaseSvc.update(req.params.id, req.organization!.id, normalizeCaseBody(value));
    return res.status(200).json(result);
  }

  static async delete(req: Request, res: Response) {
    await CaseSvc.delete(req.params.id, req.organization!.id, req.user.userId);
    return res.status(204).send();
  }

  static async archive(req: Request, res: Response) {
    const result = await CaseSvc.archive(req.params.id, req.organization!.id, req.user.userId);
    return res.status(200).json(result);
  }

  static async unarchive(req: Request, res: Response) {
    const result = await CaseSvc.unarchive(req.params.id, req.organization!.id, req.user.userId);
    return res.status(200).json(result);
  }

  /** Bulk "Select All" archive — POST /api/my-cases/archive, not /:id/archive, so it can't
   * collide with the single-case route above (different segment count). */
  static async archiveMany(req: Request, res: Response) {
    const { error, value } = bulkCaseIdsSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const result = await CaseSvc.archiveMany(value.ids, req.organization!.id, req.user.userId);
    return res.status(200).json(result);
  }

  /** Bulk "Select All" restore — POST /api/my-cases/unarchive, not /:id/unarchive, so it can't
   * collide with the single-case route above (different segment count). */
  static async unarchiveMany(req: Request, res: Response) {
    const { error, value } = bulkCaseIdsSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const result = await CaseSvc.unarchiveMany(value.ids, req.organization!.id, req.user.userId);
    return res.status(200).json(result);
  }

  static async handleCreateCaseWithDocument(req: Request, res: Response) {
    const input = {
      ...req.body,
      ...(req.params.caseId ? { caseId: String(req.params.caseId) } : {}),
    };

    const { error, value } = createCaseWithDocumentSchema.validate(input);
    if (error) throw new HttpError(error.message, 400);

    const caseData: { caseId: string; organizationId: string; userId: string } = {
      caseId: value.caseId,
      organizationId: req.organization!.id,
      userId: req.user.userId,
    };

    const documentData: IncomingCaseDocument[] = value.documentData.map((doc: any) => ({
      filename: doc.filename,
      s3Key: doc.s3Key,
      metaData: doc.metaData,
    }));


    const result = await CaseSvc.handleCreateCaseWithDocument(caseData, documentData);
    return res.status(201).json(result);
  }

  /** Rank READY case-document chunks for a query — payload for chat-wonder case grounding. */
  static async relevantChunks(req: Request, res: Response) {
    const { error, value } = relevantChunksSchema.validate(req.body, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    // Ownership check — throws 404 if the case is missing or not in this organization.
    await CaseSvc.getById(req.params.caseId, req.organization!.id);

    const result = await DocumentChunkSvc.relevantChunksForCase(
      req.params.caseId,
      value.query,
      value.limit,
    );
    return res.status(200).json(result);
  }
}
