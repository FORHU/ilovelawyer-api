import prisma from "../lib/prisma";
import { CaseGraphNodeType } from "@prisma/client";
import { isUniqueConstraintError } from "../utils/ai-generation-lock.utils";

/** Prisma's upsert is a read-then-insert, so two callers creating the same node or edge at the
 * same moment (the analysis refresh runs its steps side by side) can both miss and one insert
 * fails on the unique key. The row exists by then, so one retry finds and returns it. */
async function retryOnDuplicate<T>(upsert: () => Promise<T>): Promise<T> {
  try {
    return await upsert();
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    return upsert();
  }
}

export default class CaseGraphRepo {
  static async upsertNode(caseId: string, nodeType: CaseGraphNodeType, refId: string) {
    return retryOnDuplicate(() =>
      prisma.caseGraphNode.upsert({
        where: { nodeType_refId: { nodeType, refId } },
        create: { caseId, nodeType, refId },
        update: {},
      }),
    );
  }

  static async upsertEdge(
    caseId: string,
    sourceNodeId: string,
    targetNodeId: string,
    kind: string,
  ) {
    return retryOnDuplicate(() =>
      prisma.caseGraphEdge.upsert({
        where: { sourceNodeId_targetNodeId_kind: { sourceNodeId, targetNodeId, kind } },
        create: { caseId, sourceNodeId, targetNodeId, kind },
        update: {},
      }),
    );
  }

  static async findNode(nodeType: CaseGraphNodeType, refId: string) {
    return prisma.caseGraphNode.findUnique({ where: { nodeType_refId: { nodeType, refId } } });
  }

  static async deleteNode(nodeType: CaseGraphNodeType, refId: string) {
    await prisma.caseGraphNode.deleteMany({ where: { nodeType, refId } });
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

  /** Nodes for a case, optionally narrowed to a set of nodeTypes — used by CaseGraphViewSvc to
   * pull just the node slice a given view_type needs (e.g. TIMELINE_EVENT+PROCEDURAL_DEADLINE). */
  static async listNodesForCase(caseId: string, nodeTypes?: CaseGraphNodeType[]) {
    return prisma.caseGraphNode.findMany({
      where: { caseId, ...(nodeTypes ? { nodeType: { in: nodeTypes } } : {}) },
    });
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
