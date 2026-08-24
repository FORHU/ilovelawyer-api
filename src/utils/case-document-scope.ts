/** True when a Case Document may be used as RAG grounding for this consultation/case. */
export function documentBelongsToScope(
  doc: { userId: string; caseId: string | null; consultationId: string | null },
  scope: { userId: string; consultationId: string; caseId?: string },
): boolean {
  if (doc.userId !== scope.userId) return false;
  if (doc.consultationId === scope.consultationId) return true;
  if (scope.caseId && doc.caseId === scope.caseId) return true;
  return false;
}
