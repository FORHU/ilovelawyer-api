import crypto from "crypto";
import FilesRepo from "../repositories/files.repository";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { uploadToS3 } from "../utils/s3";

export default class FilesSvc {
  static async upload(originalName: string, buffer: Buffer, mimeType: string) {
    const key = `${crypto.randomUUID()}-${originalName}`;

    let fileUrl: string;
    try {
      fileUrl = await uploadToS3(key, buffer, mimeType);
    } catch (err) {
      logger.error("Failed to upload file to S3", { err, key, mimeType, size: buffer.length });
      throw new HttpError(
        `Failed to upload file to storage${err instanceof Error ? `: ${err.message}` : ""}`,
        502,
      );
    }

    return FilesRepo.create(originalName, fileUrl, key);
  }
}
