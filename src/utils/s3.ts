import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import jwt from "jsonwebtoken";
import type { Readable } from "stream";
import { AWS_S3_BUCKET, AWS_S3_REGION, CLOUDFRONT_URL, FILE_TOKEN_SECRET } from "../config";
import { awsCredentials } from "../lib/aws-client-config";
import { getRequestContext } from "../lib/request-context";
import logger from "./logger";

const client = new S3Client({
  region: AWS_S3_REGION,
  ...awsCredentials,
  // SDK v3 defaults checksums into PutObject signatures; browsers don't send those
  // headers on fetch PUT, so S3 returns 403 which Chrome surfaces as a CORS error.
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

const PRESIGN_EXPIRY_SECONDS = 900;

export function s3UrlForKey(key: string): string {
  if (CLOUDFRONT_URL) {
    return `${CLOUDFRONT_URL.replace(/\/+$/, "")}/${key}`;
  }
  return `https://${AWS_S3_BUCKET}.s3.${AWS_S3_REGION}.amazonaws.com/${key}`;
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

/** Server-side copy within the bucket — the bytes never pass through the API. */
export async function copyS3Object(sourceKey: string, destinationKey: string): Promise<void> {
  if (!AWS_S3_BUCKET) {
    throw new Error("AWS_S3_BUCKET is not configured");
  }
  await client.send(
    new CopyObjectCommand({
      Bucket: AWS_S3_BUCKET,
      Key: destinationKey,
      // CopySource is "<bucket>/<key>", URL-encoded per path segment.
      CopySource: `${AWS_S3_BUCKET}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`,
    }),
  );
}

/** The stored object's size in bytes, as S3 reports it, or null when there is no object at `key`.
 * A presigned PUT can't cap the upload's size, so the confirm step reads it back from here. */
export async function getObjectSize(key: string): Promise<number | null> {
  try {
    const res = await client.send(new HeadObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key }));
    return res.ContentLength ?? null;
  } catch (err) {
    if ((err as { name?: string }).name === "NotFound") return null;
    throw err;
  }
}

export async function deleteS3Object(key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key }));
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

/** What a file link points at, for the security audit log's file.accessed row — a kind and ids,
 * never the filename or key (rows outlive the case). A link without one (avatars) isn't logged. */
export interface FileLinkAudit {
  kind: "document" | "case_brief" | "generated_document" | "audio_overview";
  id?: string;
  caseId?: string | null;
}

export interface FileTokenPayload {
  s3Key: string;
  filename?: string;
  disposition: "attachment" | "inline";
  orgId?: string;
  /** The signed-in user the link was handed to — the link is a bearer token, so this is who it
   * was issued to, not proof of who opened it. Stamped from the request context at mint time. */
  uid?: string;
  audit?: FileLinkAudit;
}

/** Mints a same-origin `/files/<jwt>` path in place of a raw presigned S3 URL. The token carries
 * everything GET /files/resolve needs to mint the real (short-lived) presigned GET just before
 * ilovelawyer-app's Route Handler streams it — the S3 host, bucket and signature never reach the
 * browser this way. */
export function getProxyFileUrl(
  key: string,
  opts: { filename?: string; disposition?: "attachment" | "inline"; orgId?: string; audit?: FileLinkAudit } = {},
): string {
  const context = getRequestContext();
  const payload: FileTokenPayload = {
    s3Key: key,
    filename: opts.filename,
    disposition: opts.disposition ?? "attachment",
    orgId: opts.orgId ?? context?.organizationId() ?? undefined,
    uid: context?.userId() ?? undefined,
    audit: opts.audit,
  };
  const token = jwt.sign(payload, FILE_TOKEN_SECRET, { expiresIn: FILE_TOKEN_EXPIRY_SECONDS });
  return `/files/${token}`;
}

const STABLE_PROXY_WINDOW_SECONDS = 3600;

/** Like getProxyFileUrl (inline), but the token is issued at the start of the current hour and
 * lives two, so the same file yields the same URL for a whole hour and every URL handed out is
 * still valid for at least an hour. Used for avatars: /me is refetched often, and a URL that
 * changed on every response would make the browser re-download the image each time. */
export function getStableProxyFileUrl(key: string): string {
  const windowStart = Math.floor(Date.now() / 1000 / STABLE_PROXY_WINDOW_SECONDS) * STABLE_PROXY_WINDOW_SECONDS;
  const payload: FileTokenPayload & { iat: number } = { s3Key: key, disposition: "inline", iat: windowStart };
  const token = jwt.sign(payload, FILE_TOKEN_SECRET, { expiresIn: STABLE_PROXY_WINDOW_SECONDS * 2 });
  return `/files/${token}`;
}

/** Opens an object as a stream, for callers that pass a file along without holding it in memory
 * (the data export). `contentLength` is S3's size for the object, when it reports one. */
export async function getObjectStream(key: string): Promise<{ body: Readable; contentLength?: number }> {
  const res = await client.send(new GetObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key }));
  return { body: res.Body as Readable, contentLength: res.ContentLength };
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

/** The message to log when the bucket really lives in a different region than AWS_S3_REGION, or
 * null when they agree (or the real region is unknown). Pure, so it is testable without AWS. */
export function bucketRegionWarning(actualRegion: string | undefined, configuredRegion: string): string | null {
  if (!actualRegion || actualRegion === configuredRegion) return null;
  return (
    `S3 bucket ${AWS_S3_BUCKET} is in ${actualRegion} but AWS_S3_REGION is ${configuredRegion}. ` +
    `Presigned URLs and Textract will fail, and documents are stored outside the configured region.`
  );
}

/** Startup check: asks S3 where the document bucket actually is and warns if that is not
 * AWS_S3_REGION. Never throws or blocks boot — a failed check only logs. */
export async function verifyDocumentBucketRegion(): Promise<void> {
  if (!AWS_S3_BUCKET) return;
  try {
    let actual: string | undefined;
    try {
      actual = (await client.send(new HeadBucketCommand({ Bucket: AWS_S3_BUCKET }))).BucketRegion;
    } catch (err) {
      // Asking the wrong region fails, but S3 names the right one in a response header.
      const headers = (err as { $response?: { headers?: Record<string, string> } }).$response?.headers;
      actual = headers?.["x-amz-bucket-region"];
      if (!actual) throw err;
    }
    const warning = bucketRegionWarning(actual, AWS_S3_REGION);
    if (warning) logger.warn(warning);
  } catch (err) {
    logger.warn("Could not verify the document bucket's region", { err });
  }
}
