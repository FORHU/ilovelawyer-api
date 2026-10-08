import { Request, Response } from "express";
import ChatSvc from "../services/chat.service";
import DocumentSvc from "../services/document.service";
import HttpError from "../utils/http-error";
import {
  presignDocumentSchema,
  createDocumentSchema,
  updateDocumentSchema,
  listDocumentsSchema,
  bulkDocumentIdsSchema,
} from "../validation/document.validation";

export default class DocumentCtrl {
  static async presign(req: Request, res: Response) {
    const { error, value } = presignDocumentSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    if (value.consultationId) {
      await ChatSvc.assertConsultationAccess(req.organization!.id, req.user.userId, value.consultationId);
    }

    if (value.files) {
      const items = await DocumentSvc.presignMany(
        req.user.userId,
        value.files,
        value.caseId,
        value.consultationId,
      );
      return res.status(200).json({ items });
    }

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
    const { error, value } = createDocumentSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    if (value.consultationId) {
      await ChatSvc.assertConsultationAccess(req.organization!.id, req.user.userId, value.consultationId);
    }

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
    const { error, value } = listDocumentsSchema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const { caseId, consultationId, status } = value;

    if (caseId) {
      const docs = await DocumentSvc.listByCase(req.organization!.id, caseId, req.user.userId, status);
      return res.status(200).json(docs);
    }

    if (consultationId) {
      // Same rule as opening the consultation itself — a case-linked one follows its case (#346).
      await ChatSvc.assertConsultationAccess(req.organization!.id, req.user.userId, consultationId);
      const docs = await DocumentSvc.listByConsultation(req.organization!.id, consultationId, status);
      return res.status(200).json(docs);
    }

    const docs = await DocumentSvc.list(req.organization!.id, req.user.userId, status);
    return res.status(200).json(docs);
  }

  static async getById(req: Request, res: Response) {
    const doc = await DocumentSvc.getById(req.params.id, req.organization!.id, req.user.userId);
    return res.status(200).json(doc);
  }

  static async getTextPreview(req: Request, res: Response) {
    const result = await DocumentSvc.getTextPreview(req.params.id, req.organization!.id, req.user.userId);
    return res.status(200).json(result);
  }

  static async update(req: Request, res: Response) {
    const { error, value } = updateDocumentSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    if (value.consultationId) {
      await ChatSvc.assertConsultationAccess(req.organization!.id, req.user.userId, value.consultationId);
    }

    await DocumentSvc.update(req.params.id, req.organization!.id, req.user.userId, value);
    return res.status(204).send();
  }

  static async delete(req: Request, res: Response) {
    await DocumentSvc.delete(req.params.id, req.organization!.id, req.user.userId);
    return res.status(204).send();
  }

  static async archive(req: Request, res: Response) {
    const result = await DocumentSvc.archive(req.params.id, req.organization!.id, req.user.userId);
    return res.status(200).json(result);
  }

  static async unarchive(req: Request, res: Response) {
    const result = await DocumentSvc.unarchive(req.params.id, req.organization!.id, req.user.userId);
    return res.status(200).json(result);
  }

  /** Bulk archive — POST /api/documents/archive, not /:id/archive, so it can't collide with the
   * single-document route above (different segment count). */
  static async archiveMany(req: Request, res: Response) {
    const { error, value } = bulkDocumentIdsSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const result = await DocumentSvc.archiveMany(value.ids, req.organization!.id, req.user.userId);
    return res.status(200).json(result);
  }

  /** Bulk "Select All" restore — POST /api/documents/unarchive, not /:id/unarchive, so it can't
   * collide with the single-document route above (different segment count). */
  static async unarchiveMany(req: Request, res: Response) {
    const { error, value } = bulkDocumentIdsSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const result = await DocumentSvc.unarchiveMany(value.ids, req.organization!.id, req.user.userId);
    return res.status(200).json(result);
  }

  /** Bulk delete — DELETE /api/documents with an {ids} body, not /:id, so it can't collide with
   * the single-document route above (different segment count). */
  static async deleteMany(req: Request, res: Response) {
    const { error, value } = bulkDocumentIdsSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const result = await DocumentSvc.deleteMany(value.ids, req.organization!.id, req.user.userId);
    return res.status(200).json(result);
  }
}
