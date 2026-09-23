import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import jwt from "jsonwebtoken";
import type { Readable } from "stream";
import {
  AWS_ACCESS_KEY,
  AWS_SECRET_ACCESS_KEY,
  AWS_S3_BUCKET,
  AWS_REGION,
  CLOUDFRONT_URL,
  FILE_TOKEN_SECRET,
} from "../config";

const client = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
  // SDK v3 defaults checksums into PutObject signatures; browsers don't send those
  // headers on fetch PUT, so S3 returns 403 which Chrome surfaces as a CORS error.
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

const PRESIGN_EXPIRY_SECONDS = 300;

export function s3UrlForKey(key: string): string {
  if (CLOUDFRONT_URL) {
    return `${CLOUDFRONT_URL.replace(/\/+$/, "")}/${key}`;
  }
  return `https://${AWS_S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;
}

export async function uploadToS3(key: string, body: Buffer, contentType: string): Promise<string> {
  if (!AWS_S3_BUCKET) {
    throw new Error("AWS_S3_BUCKET is not configured");
  }

  await client.send(
    new PutObjectCommand({
      Bucket: AWS_S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );

  return s3UrlForKey(key);
}

/** Short-expiry presigned PUT the client uploads its file bytes to directly, bypassing the API. */
export async function getPresignedUploadUrl(key: string, contentType: string): Promise<string> {
  const command = new PutObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key, ContentType: contentType });
  return getSignedUrl(client, command, { expiresIn: PRESIGN_EXPIRY_SECONDS });
}

const GET_PRESIGN_EXPIRY_SECONDS = 3600;

/** The bucket has no public-read policy, so File.fileUrl (a bare S3 URL) 403s in a browser —
 * this signs a short-lived GET on read instead. Local signature computation only, no AWS call.
 * Only FilesSvc.resolve (behind GET /files/resolve) should call this now — everywhere else
 * should call getProxyFileUrl below so the S3 host/signature never reach the browser. */
export function getPresignedGetUrl(
  key: string,
  expiresIn: number = GET_PRESIGN_EXPIRY_SECONDS,
  downloadFilename?: string,
  disposition: "attachment" | "inline" = "attachment",
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: key,
    // The S3 key is a UUID, and browsers ignore <a download> on cross-origin URLs, so without
    // this the saved file is named after the key. RFC 6266: ASCII fallback + UTF-8 filename*.
    ...(downloadFilename && {
      ResponseContentDisposition: `${disposition}; filename="${downloadFilename.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(downloadFilename)}`,
    }),
  });
  return getSignedUrl(client, command, { expiresIn });
}

const FILE_TOKEN_EXPIRY_SECONDS = 3600;

export interface FileTokenPayload {
  s3Key: string;
  filename?: string;
  disposition: "attachment" | "inline";
  orgId?: string;
}

/** Mints a same-origin `/files/<jwt>` path in place of a raw presigned S3 URL. The token carries
 * everything GET /files/resolve needs to mint the real (short-lived) presigned GET just before
 * ilovelawyer-app's Route Handler streams it — the S3 host, bucket and signature never reach the
 * browser this way. */
export function getProxyFileUrl(
  key: string,
  opts: { filename?: string; disposition?: "attachment" | "inline"; orgId?: string } = {},
): string {
  const payload: FileTokenPayload = {
    s3Key: key,
    filename: opts.filename,
    disposition: opts.disposition ?? "attachment",
    orgId: opts.orgId,
  };
  const token = jwt.sign(payload, FILE_TOKEN_SECRET, { expiresIn: FILE_TOKEN_EXPIRY_SECONDS });
  return `/files/${token}`;
}

/** Downloads an object's full contents into memory — used by document extraction to read an
 * uploaded Case Document's bytes back out of S3 for text extraction. */
export async function getObjectBuffer(key: string): Promise<Buffer> {
  const res = await client.send(new GetObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key }));
  const stream = res.Body as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
