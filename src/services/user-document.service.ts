import crypto from "crypto";
import path from "path";
import UserDocumentRepo from "../repositories/user-document.repository";
import FilesRepo from "../repositories/files.repository";
import DocumentExtractionSvc from "./document-extraction.service";
import { s3UrlForKey, getPresignedUploadUrl } from "../utils/s3";
import HttpError from "../utils/http-error";

export default class UserDocumentSvc {
  /** Key branches on whether caseId is known at presign time (ADR 0011): case-scoped when it is,
   * user-scoped when it isn't (e.g. Document Analysis's "No Case" upload). The random shortId
   * guards against same-millisecond collisions when multiple files are presigned concurrently
   * for the same case/user (Create Case uploads all pending files via Promise.all). */
  static async presign(userId: string, filename: string, contentType: string, caseId?: string) {
    const ext = path.extname(filename);
    const shortId = crypto.randomUUID().slice(0, 8);
    const key = caseId
      ? `documents/cases/${caseId}/${Date.now()}-${shortId}${ext}`
      : `documents/users/${userId}/${Date.now()}-${shortId}${ext}`;
    const uploadUrl = await getPresignedUploadUrl(key, contentType);
    return { uploadUrl, key };
  }

  /** Creates the Document row for a file already uploaded to S3 via the presigned PUT from `presign()`. */
  static async create(userId: string, data: { key: string; name: string; caseId?: string }) {
    const fileUrl = s3UrlForKey(data.key);
    const file = await FilesRepo.create(data.name, fileUrl, data.key);
    const doc = await UserDocumentRepo.create(userId, { name: data.name, fileId: file.id, caseId: data.caseId });
    if (data.caseId) void DocumentExtractionSvc.process(doc.id);
    return doc;
  }

  static async list(userId: string) {
    return UserDocumentRepo.list(userId);
  }

  static async listByCase(userId: string, caseId: string) {
    return UserDocumentRepo.listByCase(userId, caseId);
  }

  static async getById(id: string, userId: string) {
    const doc = await UserDocumentRepo.findById(id, userId);
    if (!doc) throw new HttpError("Document not found", 404);
    return doc;
  }

  static async update(id: string, userId: string, data: { name?: string; caseId?: string | null }) {
    const updated = await UserDocumentRepo.update(id, userId, data);
    if (!updated) throw new HttpError("Document not found", 404);
    if (data.caseId) void DocumentExtractionSvc.process(id);
  }

  static async delete(id: string, userId: string) {
    const deleted = await UserDocumentRepo.delete(id, userId);
    if (!deleted) throw new HttpError("Document not found", 404);
  }
}
