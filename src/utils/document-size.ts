import path from "path";
import { DOCUMENT_MAX_BYTES, IMAGE_DOCUMENT_EXTENSIONS, IMAGE_DOCUMENT_MAX_BYTES } from "../constants";
import { getObjectSize, deleteS3Object } from "./s3";
import HttpError from "./http-error";
import logger from "./logger";

/** The size cap that applies to an uploaded document with this filename. */
export function maxDocumentBytes(filename: string): number {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return IMAGE_DOCUMENT_EXTENSIONS.includes(ext) ? IMAGE_DOCUMENT_MAX_BYTES : DOCUMENT_MAX_BYTES;
}

const toMb = (bytes: number) => Math.round(bytes / (1024 * 1024));

/**
 * The confirm-time size check for files uploaded through a presigned PUT, which can't limit size
 * itself. Reads each object's real size from S3, never the client's `fileSize`. If any file is
 * over its cap, those objects are deleted and the whole request is refused with a 413, before
 * any File/Document row is written. Returns the real sizes, in the same order as `uploads`, for
 * the caller to store in place of the client-reported ones.
 */
export async function assertUploadedSizesAllowed(uploads: { key: string; name: string }[]): Promise<number[]> {
  const sizes = await Promise.all(uploads.map((upload) => getObjectSize(upload.key)));

  const missing = uploads.filter((_, i) => sizes[i] === null);
  if (missing.length) {
    throw new HttpError(`Upload not found: ${missing.map((upload) => upload.name).join(", ")}`, 400);
  }

  const oversized = uploads.filter((upload, i) => (sizes[i] as number) > maxDocumentBytes(upload.name));
  if (oversized.length) {
    await Promise.all(
      oversized.map((upload) =>
        deleteS3Object(upload.key).catch((err) => logger.warn("Failed to delete oversized upload", { err, key: upload.key })),
      ),
    );
    const detail = oversized.map((upload) => `${upload.name} (limit ${toMb(maxDocumentBytes(upload.name))} MB)`).join(", ");
    throw new HttpError(`File too large: ${detail}`, 413);
  }

  return sizes as number[];
}
