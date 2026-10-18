import { DOCUMENT_UPLOAD_BATCH_MAX_BYTES } from "../constants";
import HttpError from "./http-error";

/** "1.4 GB", "350 MB", "12 KB" — binary units, matching how the limit itself is defined. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(1).replace(/\.0$/, "");
  return `${rounded} ${units[unit]}`;
}

/** Rejects one presign or confirm request whose files total over DOCUMENT_UPLOAD_BATCH_MAX_BYTES
 * with a 413. Covers this request only (up to DOCUMENT_UPLOAD_BATCH_MAX files), not the user's
 * whole selection — the web app splits a large selection across several requests, and only it
 * sees all of them (see DOCUMENT_UPLOAD_BATCH_MAX_BYTES's known limitation). Sizes the client
 * didn't send count as 0. */
export function assertBatchWithinLimit(sizes: (number | undefined)[]): void {
  const total = sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0);
  if (total <= DOCUMENT_UPLOAD_BATCH_MAX_BYTES) return;
  throw new HttpError(
    `Upload is ${formatBytes(total)} — the limit is ${formatBytes(DOCUMENT_UPLOAD_BATCH_MAX_BYTES)} per upload.`,
    413,
    "UPLOAD_BATCH_TOO_LARGE",
    { totalBytes: total, maxBytes: DOCUMENT_UPLOAD_BATCH_MAX_BYTES },
  );
}
