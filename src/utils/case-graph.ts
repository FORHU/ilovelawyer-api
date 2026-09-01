export interface GraphEdgeRef {
  sourceNodeId: string;
  targetNodeId: string;
}

/**
 * Given the full edge set for a case and the node(s) that just changed, returns every node id
 * downstream of them (the changed nodes themselves are not included). Pure/DB-free so it can be
 * unit-tested directly — CaseGraphSvc is the thin Prisma-touching wrapper around this.
 */
export function computeStaleClosure(edges: GraphEdgeRef[], changedNodeIds: string[]): string[] {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = outgoing.get(edge.sourceNodeId) ?? [];
    targets.push(edge.targetNodeId);
    outgoing.set(edge.sourceNodeId, targets);
  }

  const stale = new Set<string>();
  const queue = [...changedNodeIds];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of outgoing.get(current) ?? []) {
      if (stale.has(next)) continue;
      stale.add(next);
      queue.push(next);
    }
  }

  return [...stale];
}
