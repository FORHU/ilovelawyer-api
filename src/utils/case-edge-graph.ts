export interface CaseEdgeRef {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;
}

export interface ChainStep {
  edge: CaseEdgeRef;
  /** 1 = directly connected to the start entity, 2 = one hop further, etc. */
  depth: number;
}

/**
 * BFS over a case's edge set in one direction, never revisiting an entity (a CaseEdge graph
 * isn't guaranteed acyclic — SPONSORS/CITES pairs can point back at each other). Pure/DB-free
 * so it's unit-testable directly, same split as computeStaleClosure/CaseGraphSvc: the
 * repo/service layer only fetches the case's edges and calls in here.
 */
function walk(
  edges: CaseEdgeRef[],
  startEntityId: string,
  direction: "forward" | "backward",
  maxDepth: number,
): ChainStep[] {
  const byEntity = new Map<string, CaseEdgeRef[]>();
  for (const edge of edges) {
    const key = direction === "forward" ? edge.sourceEntityId : edge.targetEntityId;
    const list = byEntity.get(key);
    if (list) list.push(edge);
    else byEntity.set(key, [edge]);
  }

  const visited = new Set<string>([startEntityId]);
  const steps: ChainStep[] = [];
  let frontier = [startEntityId];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const entityId of frontier) {
      for (const edge of byEntity.get(entityId) ?? []) {
        const neighbor = direction === "forward" ? edge.targetEntityId : edge.sourceEntityId;
        steps.push({ edge, depth });
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }

  return steps;
}

/** Everything this entity's outgoing edges (directly or transitively) point at — e.g. what a
 * finding's evidence ultimately PROVES/SUPPORTS downstream. */
export function forwardProvenanceChain(edges: CaseEdgeRef[], entityId: string, maxDepth = 10): ChainStep[] {
  return walk(edges, entityId, "forward", maxDepth);
}

/** Everything that points at this entity (directly or transitively) via incoming edges — e.g.
 * every witness statement/document that ultimately SUPPORTS/CONTRADICTS a given claim. */
export function backwardProvenanceChain(edges: CaseEdgeRef[], entityId: string, maxDepth = 10): ChainStep[] {
  return walk(edges, entityId, "backward", maxDepth);
}

/** The 2-hop neighborhood around an entity in both directions, deduped by edge id — the slice
 * the Mind Map/citation-map UI renders when a node is focused. */
export function twoHopNeighborhood(edges: CaseEdgeRef[], entityId: string): CaseEdgeRef[] {
  const seen = new Map<string, CaseEdgeRef>();
  for (const step of [...forwardProvenanceChain(edges, entityId, 2), ...backwardProvenanceChain(edges, entityId, 2)]) {
    seen.set(step.edge.id, step.edge);
  }
  return [...seen.values()];
}
