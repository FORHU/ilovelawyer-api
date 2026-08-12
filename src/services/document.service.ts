import crypto from "crypto";
import path from "path";
import prisma from "../lib/prisma";
import DocumentRepo from "../repositories/document.repository";
import FilesRepo from "../repositories/files.repository";
import DocumentExtractionSvc from "./document-extraction.service";
import { s3UrlForKey, getPresignedUploadUrl } from "../utils/s3";
import HttpError from "../utils/http-error";

/** Flattens the related File row's fileUrl onto the Document, matching the Swagger `UserDocument`
 * contract (a top-level `fileUrl`, not a nested `file` object) — see docs/adr for the fileUrl gap
 * this closes: fileUrl was declared in the contract but no query ever included the File relation. */
export function mapDocumentToDto<T extends { file?: { fileUrl: string | null } | null }>(doc: T) {
  const { file, ...rest } = doc;
  return { ...rest, fileUrl: file?.fileUrl ?? null };
}

export default class DocumentSvc {
  /** Key branches on whether caseId is known at presign time (ADR 0011): case-scoped when it is,
   * consultation-scoped when only a consultationId (Consultation.id) is known, user-scoped
   * otherwise (e.g. Document Analysis's "No Case" upload). consultationId is only used to build
   * the S3 key here — it isn't persisted on the Document row. The random shortId guards against
   * same-millisecond collisions when multiple files are presigned concurrently for the same
   * case/user (Create Case uploads all pending files via Promise.all). */
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

  /** Creates the Document row for a file already uploaded to S3 via the presigned PUT from `presign()`.
   * Extraction/embedding is dispatched when either caseId or consultationId is given — a bare
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
    if (data.caseId || data.consultationId) void DocumentExtractionSvc.process(doc.id);
    return mapDocumentToDto(doc);
  }

  /** Bulk variant of `create()` — confirms several files uploaded to S3 in one transaction.
   * Extraction is dispatched when either caseId or consultationId is given. */
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

    const { createdDocuments, files } = await prisma.$transaction(async (tx) => {
      const files = await FilesRepo.createFile(filesToCreate, tx);

      const userDocumentData = files.map((file, i) => ({
        userId,
        caseId,
        consultationId,
        name: items[i].name,
        fileId: file.id,
      }));

      const createdDocuments = await DocumentRepo.createManyAndReturn(userDocumentData, tx);
      return { createdDocuments, files };
    });

    if (caseId || consultationId) {
      for (const doc of createdDocuments) void DocumentExtractionSvc.process(doc.id);
    }

    // createManyAndReturn can't `include` the File relation (see repo note), so fileUrl is
    // merged in here from the same-transaction `files`, which line up positionally with
    // `createdDocuments` since both were built from the same ordered `items` input.
    return createdDocuments.map((doc, i) => ({ ...doc, fileUrl: files[i].fileUrl ?? null }));
  }

  static async list(userId: string) {
    const docs = await DocumentRepo.list(userId);
    return docs.map(mapDocumentToDto);
  }

  static async listByCase(userId: string, caseId: string) {
    const docs = await DocumentRepo.listByCase(userId, caseId);
    return docs.map(mapDocumentToDto);
  }

  static async listByConsultation(userId: string, consultationId: string) {
    const docs = await DocumentRepo.listByConsultation(userId, consultationId);
    return docs.map(mapDocumentToDto);
  }

  static async getById(id: string, userId: string) {
    const doc = await DocumentRepo.findById(id, userId);
    if (!doc) throw new HttpError("Document not found", 404);
    return mapDocumentToDto(doc);
  }

  static async update(id: string, userId: string, data: { name?: string; caseId?: string | null; consultationId?: string | null }) {
    const updated = await DocumentRepo.update(id, userId, data);
    if (!updated) throw new HttpError("Document not found", 404);
    if (data.caseId || data.consultationId) void DocumentExtractionSvc.process(id);
  }

  static async delete(id: string, userId: string) {
    const deleted = await DocumentRepo.delete(id, userId);
    if (!deleted) throw new HttpError("Document not found", 404);
  }
}
