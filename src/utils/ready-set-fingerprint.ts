import crypto from "crypto";

function hashIds(ids: string[]): string {
  return crypto.createHash("sha256").update([...ids].sort().join(",")).digest("hex");
}

/** Hash of a case's sorted READY document id set — compared against Case.readySetFingerprint to
 * skip a redundant Chat Wonder refresh when the READY corpus hasn't actually changed since the
 * last successful run. Shared by both the automatic post-extraction path (case-post-extraction.ts)
 * and the manual "Refresh analysis" pipeline (CaseRefreshSvc), since either one can be the "last
 * successful refresh" the other needs to compare against. */
export function computeReadySetFingerprint(docs: { id: string; ragStatus: string }[]): string {
  return hashIds(docs.filter((d) => d.ragStatus === "READY").map((d) => d.id));
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
