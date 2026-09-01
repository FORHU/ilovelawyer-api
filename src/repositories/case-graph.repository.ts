import prisma from "../lib/prisma";
import { CaseGraphNodeType } from "@prisma/client";

export default class CaseGraphRepo {
  static async upsertNode(caseId: string, nodeType: CaseGraphNodeType, refId: string) {
    return prisma.caseGraphNode.upsert({
      where: { nodeType_refId: { nodeType, refId } },
      create: { caseId, nodeType, refId },
      update: {},
    });
  }

  static async upsertEdge(
    caseId: string,
    sourceNodeId: string,
    targetNodeId: string,
    kind: string,
  ) {
    return prisma.caseGraphEdge.upsert({
      where: { sourceNodeId_targetNodeId_kind: { sourceNodeId, targetNodeId, kind } },
      create: { caseId, sourceNodeId, targetNodeId, kind },
      update: {},
    });
  }

  static async findNode(nodeType: CaseGraphNodeType, refId: string) {
    return prisma.caseGraphNode.findUnique({ where: { nodeType_refId: { nodeType, refId } } });
  }

  /** Phase A only ever links one source to a given deadline, so the first match is enough. */
  static async findIncomingSource(nodeType: CaseGraphNodeType, refId: string) {
    const node = await prisma.caseGraphNode.findUnique({
      where: { nodeType_refId: { nodeType, refId } },
      include: { incomingEdges: { include: { source: true } } },
    });
    const source = node?.incomingEdges[0]?.source;
    return source ? { nodeType: source.nodeType, refId: source.refId } : null;
  }

  static async listEdgesForCase(caseId: string) {
    return prisma.caseGraphEdge.findMany({ where: { caseId } });
  }

  static async markNodesStale(nodeIds: string[], reason: string) {
    if (nodeIds.length === 0) return;
    await prisma.caseGraphNode.updateMany({
      where: { id: { in: nodeIds } },
      data: { staleAt: new Date(), staleReason: reason },
    });
  }

  static async clearNodeStale(nodeType: CaseGraphNodeType, refId: string) {
    await prisma.caseGraphNode.updateMany({
      where: { nodeType, refId },
      data: { staleAt: null, staleReason: null },
    });
  }

  static async listStaleForCase(caseId: string) {
    return prisma.caseGraphNode.findMany({
      where: { caseId, staleAt: { not: null } },
      select: { nodeType: true, refId: true, staleReason: true, staleAt: true },
    });
  }
}
