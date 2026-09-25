import crypto from "crypto";
import DocumentRepo from "../repositories/document.repository";

/** Hash of a sorted READY document id set. Pure, so callers that already hold the case's
 * documents (CaseSnapshotSvc) don't need another query. */
export function fingerprintReadyDocuments(docs: { id: string; ragStatus: string }[]): string {
  const readyIds = docs.filter((d) => d.ragStatus === "READY").map((d) => d.id).sort();
  return crypto.createHash("sha256").update(readyIds.join(",")).digest("hex");
}

/** The case's current READY-set hash — compared against Case.readySetFingerprint (post-upload
 * refresh) and CaseMindMap.readySetFingerprint (map rebuild / Stale badge) to skip a redundant
 * Chat Wonder run when nothing actually changed (a same-file re-upload, or a delete immediately
 * followed by a re-add). */
export async function computeReadySetFingerprint(caseId: string): Promise<string> {
  return fingerprintReadyDocuments(await DocumentRepo.listAllByCase(caseId));
}
