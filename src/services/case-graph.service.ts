import { CaseGraphNodeType } from "@prisma/client";
import CaseGraphRepo from "../repositories/case-graph.repository";
import { computeStaleClosure } from "../utils/case-graph";

/**
 * Explicit dependency tracking between Case records (Phase A: TIMELINE_EVENT ->
 * PROCEDURAL_DEADLINE only). Nodes/edges are only ever created by a service that knows the
 * derivation — nothing here infers relationships. markStale never triggers regeneration itself;
 * callers (ProceduralDeadlineSvc.recompute, etc.) clear staleness once they've actually
 * recomputed. See plan: Case Graph — Dependency & Staleness Engine (Phase A).
 */
export default class CaseGraphSvc {
  static async ensureNode(caseId: string, nodeType: CaseGraphNodeType, refId: string) {
    return CaseGraphRepo.upsertNode(caseId, nodeType, refId);
  }

  static async linkNodes(
    caseId: string,
    sourceType: CaseGraphNodeType,
    sourceRefId: string,
    targetType: CaseGraphNodeType,
    targetRefId: string,
    kind: string,
  ) {
    const [source, target] = await Promise.all([
      CaseGraphRepo.upsertNode(caseId, sourceType, sourceRefId),
      CaseGraphRepo.upsertNode(caseId, targetType, targetRefId),
    ]);
    return CaseGraphRepo.upsertEdge(caseId, source.id, target.id, kind);
  }

  static async markStale(caseId: string, nodeType: CaseGraphNodeType, refId: string, reason: string) {
    const node = await CaseGraphRepo.findNode(nodeType, refId);
    if (!node) return;

    const edges = await CaseGraphRepo.listEdgesForCase(caseId);
    const downstream = computeStaleClosure(edges, [node.id]);
    await CaseGraphRepo.markNodesStale(downstream, reason);
  }

  static async clearStale(nodeType: CaseGraphNodeType, refId: string) {
    await CaseGraphRepo.clearNodeStale(nodeType, refId);
  }

  static async findIncomingSource(nodeType: CaseGraphNodeType, refId: string) {
    return CaseGraphRepo.findIncomingSource(nodeType, refId);
  }

  static async listStaleForCase(caseId: string) {
    return CaseGraphRepo.listStaleForCase(caseId);
  }
}
