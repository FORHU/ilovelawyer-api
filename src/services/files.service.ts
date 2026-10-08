import crypto from "crypto";
import jwt from "jsonwebtoken";
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import FilesRepo from "../repositories/files.repository";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { uploadToS3, getPresignedGetUrl, FileTokenPayload } from "../utils/s3";
import { FILE_TOKEN_SECRET } from "../config";
import SecurityAuditSvc from "./security-audit.service";
import AuditSvc, { AuditAction } from "./audit.service";

type DbClient = Prisma.TransactionClient | typeof prisma;

/** Tokens already logged as file.accessed, so an <audio> element's dozen Range requests (each a
 * resolve) make one audit row, not twelve. Per instance and in memory: a link opened on two API
 * instances may log twice, which errs on the side of more record, never less. Entries go once
 * the token itself would have expired. */
const loggedTokens = new Map<string, number>();
const LOGGED_TOKENS_MAX = 10_000;

function firstResolveOf(token: string, expiresAtMs: number, now = Date.now()): boolean {
  const key = crypto.createHash("sha256").update(token).digest("base64url");
  if (loggedTokens.has(key)) return false;
  if (loggedTokens.size >= LOGGED_TOKENS_MAX) {
    for (const [k, exp] of loggedTokens) if (exp <= now) loggedTokens.delete(k);
    if (loggedTokens.size >= LOGGED_TOKENS_MAX) loggedTokens.delete(loggedTokens.keys().next().value!);
  }
  loggedTokens.set(key, expiresAtMs);
  return true;
}

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

    // Avatars and other links minted without an audit target aren't client data and aren't logged.
    const { audit } = payload;
    if (audit && firstResolveOf(token, ((payload as { exp?: number }).exp ?? 0) * 1000)) {
      await SecurityAuditSvc.record({
        action: "file.accessed",
        actorId: payload.uid ?? null,
        ...(payload.orgId && { organizationId: payload.orgId }),
        targetType: audit.kind === "document" ? "document" : "file",
        targetId: audit.id ?? null,
        caseId: audit.caseId ?? null,
        payload: { kind: audit.kind, disposition: payload.disposition, via: "file_link" },
      });
    }

    // The token carries no user, only the org it was minted for, so the event has no actor.
    await AuditSvc.record({ action: AuditAction.FileDownloaded, payload: { s3Key: payload.s3Key, orgId: payload.orgId } });
    return getPresignedGetUrl(payload.s3Key, 60, payload.filename, payload.disposition);
  }
}
