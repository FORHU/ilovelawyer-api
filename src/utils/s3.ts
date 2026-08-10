import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "stream";
import { AWS_ACCESS_KEY, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET, AWS_REGION, CLOUDFRONT_URL } from "../config";

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
