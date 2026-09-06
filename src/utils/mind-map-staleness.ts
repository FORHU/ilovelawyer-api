/** Case activity (AuditEvent) newer than the case's most recent mind map generation means the
 * strategy map may no longer reflect the case — see CaseSnapshotSvc.get. Never stale if no map
 * has been generated yet; that's the empty-state "Generate" CTA's job, not this signal's. */
export function isMindMapStale(lastGeneratedAt: Date | null, latestAuditAt: Date | null): boolean {
  if (!lastGeneratedAt) return false;
  if (!latestAuditAt) return false;
  return latestAuditAt.getTime() > lastGeneratedAt.getTime();
}
