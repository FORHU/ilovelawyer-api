import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  AWS_ACCESS_KEY,
  AWS_SECRET_ACCESS_KEY,
  AWS_S3_BUCKET,
  AWS_REGION,
  CLOUDFRONT_URL,
} from "../config";

const client = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

export async function uploadToS3(
  key: string,
  body: Buffer,
  contentType: string,
) {
  await client.send(
    new PutObjectCommand({
      Bucket: AWS_S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );

  return key;
}

export async function getPresignedUrl(key: string) {
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: AWS_S3_BUCKET,
      Key: key,
    }),
    {
      expiresIn: 60 * 60, // 1 hour
    },
  );
}

export function getPublicUrl(key: string) {
  if (CLOUDFRONT_URL) {
    return `${CLOUDFRONT_URL.replace(/\/+$/, "")}/${key}`;
  }

  return `https://${AWS_S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;
}