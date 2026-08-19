/** Max files per presign or confirm request. The client chunks larger sets into batches of this size. */
export const DOCUMENT_UPLOAD_BATCH_MAX = 50;

/** Prisma interactive-transaction timeout for bulk File+Document inserts. */
export const DOCUMENT_CONFIRM_TX_TIMEOUT_MS = 30_000;
