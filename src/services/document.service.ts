import crypto from "crypto";
import path from "path";
import prisma from "../lib/prisma";
import DocumentRepo from "../repositories/document.repository";
import FilesRepo from "../repositories/files.repository";
import DocumentExtractionQueue from "../queues/document-extraction.queue";
import { s3UrlForKey, getPresignedUploadUrl } from "../utils/s3";
import HttpError from "../utils/http-error";
import { DOCUMENT_CONFIRM_TX_TIMEOUT_MS } from "../constants/document-upload.constants";

export default class DocumentSvc {
  /** Key branches on whether caseId is known at presign time (ADR 0011): case-scoped when it is,
   * consultation-scoped when only a consultationId (Consultation.id) is known, user-scoped
   * otherwise (e.g. Document Analysis's "No Case" upload). consultationId is only used to build
   * the S3 key here — it isn't persisted on the Document row. The random shortId guards against
   * same-millisecond collisions when multiple files are presigned concurrently for the same
   * case/user (Create Case uploads pending files in a concurrency pool, then confirms in batches). */
  static async presign(userId: string, filename: string, contentType: string, caseId?: string, consultationId?: string) {
    const ext = path.extname(filename);
    const shortId = crypto.randomUUID().slice(0, 8);
    const key = caseId
      ? `documents/cases/${caseId}/${Date.now()}-${shortId}${ext}`
      : consultationId
        ? `documents/consultations/${consultationId}/${Date.now()}-${shortId}${ext}`
        : `documents/users/${userId}/${Date.now()}-${shortId}${ext}`;
    const uploadUrl = await getPresignedUploadUrl(key, contentType);
    return { uploadUrl, key };
  }

  static async presignMany(
    userId: string,
    files: { filename: string; contentType: string }[],
    caseId?: string,
    consultationId?: string,
  ) {
    return Promise.all(
      files.map((file) => this.presign(userId, file.filename, file.contentType, caseId, consultationId)),
    );
  }

  /** Creates the Document row for a file already uploaded to S3 via the presigned PUT from `presign()`.
   * Extraction/embedding is queued when either caseId or consultationId is given — a bare
   * upload with neither (e.g. Document Analysis's "No Case" flow) stays un-embedded, since nothing
   * will ever query it via chat RAG and there's no reason to pay for that OpenAI call. */
  static async create(userId: string, data: { key: string; name: string; caseId?: string; consultationId?: string }) {
    const fileUrl = s3UrlForKey(data.key);
    const file = await FilesRepo.create(data.name, fileUrl, data.key);
    const doc = await DocumentRepo.create(userId, {
      name: data.name,
      fileId: file.id,
      caseId: data.caseId,
      consultationId: data.consultationId,
    });
    if (data.caseId || data.consultationId) DocumentExtractionQueue.enqueue(doc.id);
    return doc;
  }

  /** Bulk variant of `create()` — confirms several files uploaded to S3 in one transaction.
   * Extraction is queued when either caseId or consultationId is given. */
  static async createMany(
    userId: string,
    items: { key: string; name: string }[],
    caseId?: string,
    consultationId?: string,
  ) {
    const filesToCreate: Express.FileTypes[] = items.map((item) => ({
      filename: item.name,
      fileUrl: s3UrlForKey(item.key),
      s3Key: item.key,
    }));

    const createdDocuments = await prisma.$transaction(async (tx) => {
      const files = await FilesRepo.createFile(filesToCreate, tx);

      const userDocumentData = files.map((file, i) => ({
        userId,
        caseId,
        consultationId,
        name: items[i].name,
        fileId: file.id,
      }));

      return DocumentRepo.createManyAndReturn(userDocumentData, tx);
    }, { timeout: DOCUMENT_CONFIRM_TX_TIMEOUT_MS });

    if (caseId || consultationId) {
      DocumentExtractionQueue.enqueueMany(createdDocuments.map((doc) => doc.id));
    }

    return createdDocuments;
  }

  static async list(userId: string) {
    return DocumentRepo.list(userId);
  }

  static async listByCase(userId: string, caseId: string) {
    return DocumentRepo.listByCase(userId, caseId);
  }

  static async listByConsultation(userId: string, consultationId: string) {
    return DocumentRepo.listByConsultation(userId, consultationId);
  }

  static async getById(id: string, userId: string) {
    const doc = await DocumentRepo.findById(id, userId);
    if (!doc) throw new HttpError("Document not found", 404);
    return doc;
  }

  static async update(id: string, userId: string, data: { name?: string; caseId?: string | null; consultationId?: string | null }) {
    const updated = await DocumentRepo.update(id, userId, data);
    if (!updated) throw new HttpError("Document not found", 404);
    if (data.caseId || data.consultationId) DocumentExtractionQueue.enqueue(id);
  }

  static async delete(id: string, userId: string) {
    const deleted = await DocumentRepo.delete(id, userId);
    if (!deleted) throw new HttpError("Document not found", 404);
  }
}
