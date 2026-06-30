import crypto from "crypto";
import FilesRepo from "../repositories/files.repository";
import { uploadToS3 } from "../utils/s3";

export default class FilesSvc {
  static async upload(originalName: string, buffer: Buffer, mimeType: string) {
    const key = `${crypto.randomUUID()}-${originalName}`;
    const fileUrl = await uploadToS3(key, buffer, mimeType);
    return FilesRepo.create(originalName, fileUrl);
  }
}
