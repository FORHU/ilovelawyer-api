/** Max files per presign or confirm request. The client chunks larger sets into batches of this size. */
export const DOCUMENT_UPLOAD_BATCH_MAX = 50;

/** Max ids per bulk archive-state request (documents or cases) — mass "Select All" restore/archive
 * from the UI is bounded by this, same as an upload batch, so one request can't ask for an
 * unbounded Promise.allSettled fan-out. */
export const BULK_ACTION_MAX = 50;

/** Document Analysis / case evidence upload's declared supported formats. The client already
 * filters to these before ever calling presign/create, but that's advisory only — anyone can
 * call the API directly, so this is the authoritative check (enforced via filename extension in
 * document.validation.ts / case.validation.ts). */
export const ALLOWED_DOCUMENT_EXTENSIONS = ["pdf", "doc", "docx", "xlsx", "xlsm", "xlam", "jpg", "jpeg", "png", "mp3", "mp4"];

/** Audio/video evidence — no text layer to extract, so the extraction pipeline transcribes these
 * with AWS Transcribe (see DocumentExtractionSvc) and indexes the transcript instead. */
export const MEDIA_DOCUMENT_EXTENSIONS = ["mp3", "mp4"];
export const MEDIA_DOCUMENT_MIME_TYPES = ["audio/mpeg", "audio/mp3", "video/mp4", "audio/mp4"];

export const ALLOWED_DOCUMENT_FILENAME_PATTERN = new RegExp(
  `\\.(${ALLOWED_DOCUMENT_EXTENSIONS.join("|")})$`,
  "i",
);

/** Prisma interactive-transaction timeout for bulk File+Document inserts. */
export const DOCUMENT_CONFIRM_TX_TIMEOUT_MS = 30_000;
