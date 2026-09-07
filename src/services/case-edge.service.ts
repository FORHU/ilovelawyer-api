import CaseEdgeRepo, { CaseEdgeInput } from "../repositories/case-edge.repository";
import CaseAccess from "../utils/case-access";
import OrganizationRepo from "../repositories/organization.repository";
import HttpError from "../utils/http-error";
import { forwardProvenanceChain, backwardProvenanceChain, twoHopNeighborhood } from "../utils/case-edge-graph";

/**
 * Evidentiary/argumentation links between CaseGraphNode entities — SUPPORTS/CONTRADICTS/CITES/
 * PROVES/REFUTES/SPONSORS — backing the Mind Map and citation-map panels. Distinct from
 * CaseGraphSvc (Phase A/B's dependency+staleness engine): that one has a free-form `kind` and
 * is walked only for recompute closure, this one has a closed relation vocabulary the UI
 * renders distinctly and carries per-edge metadata. Linking is always an explicit call here
 * too — nothing infers a SUPPORTS/CONTRADICTS relationship on its own.
 */
export default class CaseEdgeSvc {
  static async list(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return CaseEdgeRepo.listForCase(caseId);
  }

  static async create(caseId: string, userId: string, data: CaseEdgeInput) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const row = await CaseEdgeRepo.create(caseId, data);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "edge.create", payload: { id: row.id, relationType: row.relationType } });
    return row;
  }

  static async delete(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const deleted = await CaseEdgeRepo.delete(id, caseId);
    if (!deleted) throw new HttpError("Edge not found", 404);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "edge.delete", payload: { id } });
  }

  /** Forward provenance chain from `entityId` — everything its outgoing edges reach,
   * directly or transitively (e.g. what a piece of evidence ultimately PROVES). */
  static async forwardChain(caseId: string, userId: string, entityId: string, maxDepth?: number) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    const edges = await CaseEdgeRepo.listForCase(caseId);
    return forwardProvenanceChain(edges, entityId, maxDepth);
  }

  /** Backward provenance chain into `entityId` — everything whose outgoing edges reach it,
   * directly or transitively (e.g. every fact that ultimately SUPPORTS a claim). */
  static async backwardChain(caseId: string, userId: string, entityId: string, maxDepth?: number) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    const edges = await CaseEdgeRepo.listForCase(caseId);
    return backwardProvenanceChain(edges, entityId, maxDepth);
  }

  /** The 2-hop neighborhood around `entityId` in both directions — the slice the Mind Map
   * renders when a node is focused. */
  static async neighborhood(caseId: string, userId: string, entityId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    const edges = await CaseEdgeRepo.listForCase(caseId);
    return twoHopNeighborhood(edges, entityId);
  }
}
