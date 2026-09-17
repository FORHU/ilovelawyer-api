/** Max files per presign or confirm request. The client chunks larger sets into batches of this size. */
export const DOCUMENT_UPLOAD_BATCH_MAX = 50;

/** Document Analysis / case evidence upload's declared supported formats. The client already
 * filters to these before ever calling presign/create, but that's advisory only — anyone can
 * call the API directly, so this is the authoritative check (enforced via filename extension in
 * document.validation.ts / case.validation.ts). */
export const ALLOWED_DOCUMENT_EXTENSIONS = ["pdf", "docx", "xlsx", "jpg", "jpeg", "png"];

export const ALLOWED_DOCUMENT_FILENAME_PATTERN = new RegExp(
  `\\.(${ALLOWED_DOCUMENT_EXTENSIONS.join("|")})$`,
  "i",
);

/** Prisma interactive-transaction timeout for bulk File+Document inserts. */
export const DOCUMENT_CONFIRM_TX_TIMEOUT_MS = 30_000;
