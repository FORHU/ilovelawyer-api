import crypto from "crypto";
import UserDocumentRepo from "../repositories/user-document.repository";
import { uploadToS3 } from "../utils/s3";
import HttpError from "../utils/http-error";

export default class UserDocumentSvc {
  static async upload(userId: string, file: Express.Multer.File, caseId?: string) {
    const s3Key = `documents/${userId}/${crypto.randomUUID()}-${file.originalname}`;
    const fileUrl = await uploadToS3(s3Key, file.buffer, file.mimetype);
    return UserDocumentRepo.create(userId, { name: file.originalname, fileUrl, s3Key, caseId });
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
    const updated = await UserDocumentRepo.update(id, userId, data);
    if (!updated) throw new HttpError("Document not found", 404);
  }

  static async delete(id: string, userId: string) {
    const deleted = await UserDocumentRepo.delete(id, userId);
    if (!deleted) throw new HttpError("Document not found", 404);
  }
}
