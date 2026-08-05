import crypto from "crypto";
import path from "path";
import UserDocumentRepo from "../repositories/user-document.repository";
import { s3UrlForKey, getPresignedUploadUrl } from "../utils/s3";
import DocumentExtractionSvc from "./document-extraction.service";
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

  /** Creates the Document row for a file already uploaded to S3 (via the presigned PUT from
   * `presign()`) and, if it's linked to a Case, dispatches extraction fire-and-forget — same
   * pattern as `ChatSvc.generateAndSaveTitle`'s dispatch. Documents with no Case yet (e.g.
   * uploaded from the Create Case flow before the Case exists) skip extraction until `update()`
   * links one. */
  static async create(userId: string, data: { key: string; name: string; caseId?: string }) {
    const fileUrl = s3UrlForKey(data.key);
    const doc = await UserDocumentRepo.create(userId, { name: data.name, fileUrl, s3Key: data.key, caseId: data.caseId });
    if (data.caseId) {
      DocumentExtractionSvc.process(doc).catch(() => {});
    }
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

  static async update(id: string, userId: string, data: { name?: string; caseId?: string | null; aiSummary?: string }) {
    const existing = await UserDocumentRepo.findById(id, userId);
    if (!existing) throw new HttpError("Document not found", 404);

    const updated = await UserDocumentRepo.update(id, userId, data);
    if (!updated) throw new HttpError("Document not found", 404);

    // A Document uploaded before its Case existed (Create Case flow) gets linked afterward —
    // dispatch extraction now that it has somewhere to be retrieved from. s3Key/name are
    // unchanged by a caseId-only link, so `existing` still describes the right file.
    if (existing.caseId === null && data.caseId) {
      DocumentExtractionSvc.process(existing).catch(() => {});
    }
  }

  static async delete(id: string, userId: string) {
    const deleted = await UserDocumentRepo.delete(id, userId);
    if (!deleted) throw new HttpError("Document not found", 404);
  }
}
