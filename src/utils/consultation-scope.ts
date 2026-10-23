import type { WorkspaceScope } from "./workspace";

/** Whether a consultation is reachable from the workspace (a firm, or a lawyer's own) a request came in
 * through. A main (standalone) consultation has no organization — it belongs to its user alone,
 * so it is reachable from every workspace they open (who may use it is decided by its creator,
 * see ChatSvc.assertUserAccess). A case's consultation lives with the case's organization. */
export function consultationInWorkspace(
  consultation: { caseId: string | null; organizationId: string | null },
  scope: WorkspaceScope,
): boolean {
  // In a lawyer's own workspace both are null; whose case it is, CaseAccess decides after this.
  return consultation.caseId ? consultation.organizationId === scope.organizationId : true;
}
