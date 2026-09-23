import crypto from "crypto";
import jwt from "jsonwebtoken";
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import FilesRepo from "../repositories/files.repository";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { uploadToS3, getPresignedGetUrl, FileTokenPayload } from "../utils/s3";
import { FILE_TOKEN_SECRET } from "../config";

type DbClient = Prisma.TransactionClient | typeof prisma;

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

  static async createFile(payload: Express.FileTypes[], client: DbClient = prisma) {
    const files = await FilesRepo.createFile(payload, client);
    return files;
  }

  /** Verifies a getProxyFileUrl token and mints the real (60s) presigned GET behind it. Any
   * failure — bad signature, expired, wrong shape — reports as a generic 404: never echo the
   * jwt error message, which can hint that the token is a JWT at all. */
  static async resolve(token: string): Promise<string> {
    let payload: FileTokenPayload;
    try {
      payload = jwt.verify(token, FILE_TOKEN_SECRET) as FileTokenPayload;
    } catch {
      throw new HttpError("Not found", 404);
    }
    if (!payload?.s3Key) {
      throw new HttpError("Not found", 404);
    }

    return getPresignedGetUrl(payload.s3Key, 60, payload.filename, payload.disposition);
  }
}
