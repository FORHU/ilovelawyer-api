import type { RagStatus } from "@prisma/client";

/**
 * #159's uploading/processing/done/failed vocabulary for the client-facing evidence UI, as a thin
 * relabeling of the existing `ragStatus` state machine (document-extraction.service.ts) — not a
 * new state. "uploading" has no `ragStatus` counterpart: a Document row (and so a `ragStatus`)
 * only exists once the upload is confirmed, so that state is the client's own, held before this
 * function is ever called.
 */
export type EvidenceSyncStatus = "processing" | "done" | "failed";

const LABELS: Record<RagStatus, EvidenceSyncStatus> = {
  PENDING: "processing",
  READY: "done",
  FAILED: "failed",
};

export function evidenceSyncStatus(ragStatus: RagStatus): EvidenceSyncStatus {
  return LABELS[ragStatus];
}
