// Safety/performance caps for a mind map tree — not a renderer limit (the app's 2D and 3D views
// draw any depth). Mirrored in ilovelawyer-app's components/chat/mind-map/constants.ts; change
// both together, and only raise them once a map of the new size still renders smoothly.
export const MIND_MAP_LIMITS = {
  /** Levels below the root; the root itself is level 0. */
  maxDepth: 6,
  /** Total nodes in one map, root included. */
  maxNodes: 150,
  /** Children one "Expand with AI" call may add to a node. */
  expandMin: 2,
  expandMax: 5,
} as const;

/** The five first-level branches every map is built around, keyed by their stable node id.
 * Matched against a model-sent id or label with everything but letters/digits stripped, so
 * "Legal Basis", "legal_basis" and "legalBasis" all land on `legalBasis`. */
export const MIND_MAP_FIXED_BRANCH_IDS: Record<string, string> = {
  legalbasis: "legalBasis",
  keyfacts: "keyFacts",
  remedies: "remedies",
  risks: "risks",
  nextsteps: "nextSteps",
};
