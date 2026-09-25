import crypto from "crypto";

/** Hash of a case's sorted READY document id set — compared against Case.readySetFingerprint to
 * skip a redundant Chat Wonder refresh when the READY corpus hasn't actually changed since the
 * last successful run. Shared by both the automatic post-extraction path (case-post-extraction.ts)
 * and the manual "Refresh analysis" pipeline (CaseRefreshSvc), since either one can be the "last
 * successful refresh" the other needs to compare against. */
export function computeReadySetFingerprint(docs: { id: string; ragStatus: string }[]): string {
  const readyIds = docs.filter((d) => d.ragStatus === "READY").map((d) => d.id).sort();
  return crypto.createHash("sha256").update(readyIds.join(",")).digest("hex");
}
