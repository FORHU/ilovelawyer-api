import { CaseGraphNodeType } from "@prisma/client";
import CaseAccess from "../utils/case-access";
import CaseGraphRepo from "../repositories/case-graph.repository";
import CaseEdgeRepo from "../repositories/case-edge.repository";
import CaseTimelineRepo from "../repositories/case-timeline.repository";
import ProceduralDeadlineRepo from "../repositories/procedural-deadline.repository";
import WitnessRepo from "../repositories/witness.repository";
import CaseFindingRepo from "../repositories/case-finding.repository";
import CaseClaimRepo from "../repositories/case-claim.repository";
import EvidenceRepo from "../repositories/evidence.repository";
import DocumentRepo from "../repositories/document.repository";

export type GraphViewType = "timeline" | "witnesses" | "contradictions" | "issues";

export interface GraphViewNode {
  id: string;
  type: string;
  refId: string;
  label: string;
  staleAt: string | null;
  data: Record<string, unknown>;
}

export interface GraphViewEdge {
  id: string;
  source: string;
  target: string;
  relationType: string;
  metadata: Record<string, unknown>;
}

export interface GraphViewResult {
  viewType: GraphViewType;
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
}

/**
 * Projects CaseGraphNode/CaseEdge into the shape each panel needs, so Timeline/Witnesses/
 * Contradictions/Issues all read one standardized {nodes, edges} envelope instead of slicing
 * CaseSnapshotSvc's monolithic payload. `contradictions` is the one exception: DOCUMENT nodes
 * are declared in CaseGraphNodeType but never registered (see the schema comment on
 * CaseGraphNode — no safe single insertion point for documents yet), so nothing has ever
 * written a CaseEdge with relationType CONTRADICTS. That branch bridges the existing
 * EvidenceContradiction table into the same node/edge envelope instead; once documents get
 * graph-registered, swap it for a real CaseEdgeRepo-backed query like the other three.
 */
export default class CaseGraphViewSvc {
  static async get(caseId: string, userId: string, viewType: GraphViewType): Promise<GraphViewResult> {
    await CaseAccess.loadAccessibleCase(caseId, userId);

    switch (viewType) {
      case "timeline":
        return this.timelineView(caseId);
      case "witnesses":
        return this.witnessesView(caseId);
      case "issues":
        return this.issuesView(caseId);
      case "contradictions":
        return this.contradictionsView(caseId);
    }
  }

  private static async timelineView(caseId: string): Promise<GraphViewResult> {
    const [graphNodes, graphEdges, events, deadlines] = await Promise.all([
      CaseGraphRepo.listNodesForCase(caseId, ["TIMELINE_EVENT", "PROCEDURAL_DEADLINE"]),
      CaseGraphRepo.listEdgesForCase(caseId),
      CaseTimelineRepo.list(caseId),
      ProceduralDeadlineRepo.list(caseId),
    ]);

    const eventById = new Map(events.map((e) => [e.id, e]));
    const deadlineById = new Map(deadlines.map((d) => [d.id, d]));

    const nodes: GraphViewNode[] = graphNodes.map((node) => {
      if (node.nodeType === "TIMELINE_EVENT") {
        const event = eventById.get(node.refId);
        return this.toNode(node, event?.title ?? "Untitled event", event ?? {});
      }
      const deadline = deadlineById.get(node.refId);
      return this.toNode(node, deadline?.label ?? "Untitled deadline", deadline ?? {});
    });

    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges: GraphViewEdge[] = graphEdges
      .filter((edge) => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId))
      .map((edge) => ({
        id: edge.id,
        source: edge.sourceNodeId,
        target: edge.targetNodeId,
        relationType: edge.kind,
        metadata: {},
      }));

    return { viewType: "timeline", nodes, edges };
  }

  private static async witnessesView(caseId: string): Promise<GraphViewResult> {
    const [graphNodes, witnesses] = await Promise.all([
      CaseGraphRepo.listNodesForCase(caseId, ["WITNESS"]),
      WitnessRepo.list(caseId),
    ]);
    const witnessById = new Map(witnesses.map((w) => [w.id, w]));

    const nodes: GraphViewNode[] = graphNodes.map((node) => {
      const witness = witnessById.get(node.refId);
      return this.toNode(node, witness?.name ?? "Unnamed witness", witness ?? {});
    });

    return { viewType: "witnesses", nodes, edges: await this.edgesTouching(caseId, nodes) };
  }

  private static async issuesView(caseId: string): Promise<GraphViewResult> {
    const [findingNodes, claimNodes, findings, claims] = await Promise.all([
      CaseGraphRepo.listNodesForCase(caseId, ["FINDING"]),
      CaseGraphRepo.listNodesForCase(caseId, ["CLAIM"]),
      CaseFindingRepo.list(caseId, "LEGAL_ISSUE"),
      CaseClaimRepo.list(caseId),
    ]);
    const findingById = new Map(findings.map((f) => [f.id, f]));
    const claimById = new Map(claims.map((c) => [c.id, c]));

    const nodes: GraphViewNode[] = [
      ...findingNodes
        .filter((node) => findingById.has(node.refId))
        .map((node) => {
          const finding = findingById.get(node.refId)!;
          return this.toNode(node, finding.label, finding);
        }),
      ...claimNodes.map((node) => {
        const claim = claimById.get(node.refId);
        return this.toNode(node, claim?.title ?? "Untitled claim", claim ?? {});
      }),
    ];

    return { viewType: "issues", nodes, edges: await this.edgesTouching(caseId, nodes) };
  }

  private static async contradictionsView(caseId: string): Promise<GraphViewResult> {
    const [contradictions, documents] = await Promise.all([
      EvidenceRepo.listContradictions(caseId),
      DocumentRepo.listAllByCase(caseId),
    ]);
    const documentById = new Map(documents.map((d) => [d.id, d]));

    const nodeIds = new Set<string>();
    const nodes: GraphViewNode[] = [];
    const addDocumentNode = (documentId: string) => {
      const nodeId = `document:${documentId}`;
      if (nodeIds.has(nodeId)) return;
      nodeIds.add(nodeId);
      const document = documentById.get(documentId);
      nodes.push({
        id: nodeId,
        type: "DOCUMENT",
        refId: documentId,
        label: document?.name ?? "Unknown document",
        staleAt: null,
        data: document ?? {},
      });
    };

    const edges: GraphViewEdge[] = contradictions.map((contradiction) => {
      addDocumentNode(contradiction.leftDocumentId);
      addDocumentNode(contradiction.rightDocumentId);
      return {
        id: contradiction.id,
        source: `document:${contradiction.leftDocumentId}`,
        target: `document:${contradiction.rightDocumentId}`,
        relationType: "CONTRADICTS",
        metadata: {
          kind: contradiction.kind,
          factKey: contradiction.factKey,
          leftExcerpt: contradiction.leftExcerpt,
          rightExcerpt: contradiction.rightExcerpt,
          leftValue: contradiction.leftValue,
          rightValue: contradiction.rightValue,
          confidence: contradiction.confidence,
        },
      };
    });

    return { viewType: "contradictions", nodes, edges };
  }

  /** CaseEdge rows (SUPPORTS/CONTRADICTS/CITES/PROVES/REFUTES/SPONSORS) touching any of the
   * given graph nodes — shared by the witnesses/issues views, both of which resolve edges the
   * same way, just against a different node set. */
  private static async edgesTouching(caseId: string, nodes: GraphViewNode[]): Promise<GraphViewEdge[]> {
    const nodeIds = new Set(nodes.map((n) => n.id));
    const allEdges = await CaseEdgeRepo.listForCase(caseId);
    return allEdges
      .filter((edge) => nodeIds.has(edge.sourceEntityId) || nodeIds.has(edge.targetEntityId))
      .map((edge) => ({
        id: edge.id,
        source: edge.sourceEntityId,
        target: edge.targetEntityId,
        relationType: edge.relationType,
        metadata: (edge.metadata as Record<string, unknown>) ?? {},
      }));
  }

  private static toNode(
    node: { id: string; nodeType: CaseGraphNodeType; refId: string; staleAt: Date | null },
    label: string,
    data: Record<string, unknown>,
  ): GraphViewNode {
    return {
      id: node.id,
      type: node.nodeType,
      refId: node.refId,
      label,
      staleAt: node.staleAt ? node.staleAt.toISOString() : null,
      data,
    };
  }
}
