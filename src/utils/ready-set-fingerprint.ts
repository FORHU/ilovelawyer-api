import crypto from "crypto";
import DocumentRepo from "../repositories/document.repository";

function hashIds(ids: string[]): string {
  return crypto.createHash("sha256").update([...ids].sort().join(",")).digest("hex");
}

/** Hash of a sorted READY document id set. Pure, so callers that already hold the case's
 * documents (CaseSnapshotSvc) don't need another query. */
export function fingerprintReadyDocuments(docs: { id: string; ragStatus: string }[]): string {
  return hashIds(docs.filter((d) => d.ragStatus === "READY").map((d) => d.id));
}

/** The case's current READY-set hash — compared against Case.readySetFingerprint by the
 * post-upload refresh (case-post-extraction.ts) to skip a redundant Chat Wonder run when nothing
 * actually changed (a same-file re-upload, or a delete immediately followed by a re-add). */
export async function computeReadySetFingerprint(caseId: string): Promise<string> {
  return fingerprintReadyDocuments(await DocumentRepo.listAllByCase(caseId));
}

/**
 * The documents a case mind map is built from: READY and not archived. Narrower than the READY
 * set above on purpose — an archived document is out of chat grounding already, and the map
 * follows chat rather than the rest of the case analysis (see DocumentSvc.archive). Sorted.
 */
export function mindMapDocumentIds(docs: { id: string; ragStatus: string; status?: string | null }[]): string[] {
  return docs
    .filter((d) => d.ragStatus === "READY" && d.status !== "ARCHIVED")
    .map((d) => d.id)
    .sort();
}

/** Hash of mindMapDocumentIds — CaseMindMap.readySetFingerprint. */
export function fingerprintMindMapDocuments(docs: { id: string; ragStatus: string; status?: string | null }[]): string {
  return hashIds(mindMapDocumentIds(docs));
}

/** What changed between the documents a map was built from and the case's documents now. */
export function diffDocumentIds(builtFrom: string[], current: string[]): { added: string[]; removed: string[] } {
  const before = new Set(builtFrom);
  const now = new Set(current);
  return {
    added: current.filter((id) => !before.has(id)),
    removed: builtFrom.filter((id) => !now.has(id)),
  };
}
