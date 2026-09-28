// Pure tree helpers for MindMapSvc's expand/undo — no DB, no Chat Wonder, so they're unit-tested
// directly (test/mind-map-tree.spec.ts). Every tree passed in is expected to be normalized
// already (normalizeMindMap: path ids, depth set).

import { MIND_MAP_CHILDREN_TAG } from "../constants/mind-map-expand.constants";
import { MindMapItem, normalizeMindMap, parseAiJson } from "./response-parser";

export interface FoundMindMapNode {
  node: MindMapItem;
  /** Root first, the node itself last. */
  path: MindMapItem[];
  parent: MindMapItem | null;
}

/** Finds a node by its path id, or — for a client still holding a map saved before ids were
 * normalized — by the model id normalizeMindMap kept as `sourceId`. */
export function findMindMapNode(root: MindMapItem, id: string): FoundMindMapNode | null {
  const walk = (node: MindMapItem, path: MindMapItem[]): FoundMindMapNode | null => {
    const here = [...path, node];
    if (node.id === id || node.sourceId === id) return { node, path: here, parent: path[path.length - 1] ?? null };
    for (const child of node.children) {
      const hit = walk(child, here);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, []);
}

export function countMindMapNodes(root: MindMapItem): number {
  return 1 + root.children.reduce((n, child) => n + countMindMapNodes(child), 0);
}

export interface ExpandedChild {
  label: string;
  description?: string;
  /** As the model returned them — validated by normalizeMindMap and filtered to the case's
   * documents (keepOnlyCaseSources) once appended. */
  sources?: unknown[];
}

const normalizeLabel = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Reads the `[MINDMAP_CHILDREN][...][/MINDMAP_CHILDREN]` block the expand prompt asks for (an
 * unclosed tag or a bare array/`{children:[...]}` also work — models drift). Drops empty labels,
 * anything that repeats a label in `avoid` (siblings + existing children), and duplicates within
 * the reply itself; returns at most `max`.
 */
export function parseExpandedChildren(text: string, avoid: string[], max: number): ExpandedChild[] {
  const open = `[${MIND_MAP_CHILDREN_TAG}]`;
  const start = text.indexOf(open);
  let body = start === -1 ? text : text.slice(start + open.length);
  const end = body.indexOf(`[/${MIND_MAP_CHILDREN_TAG}]`);
  if (end !== -1) body = body.slice(0, end);

  const parsed: any = parseAiJson(body.trim());
  const list: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.children) ? parsed.children : [];

  const seen = new Set(avoid.map(normalizeLabel));
  const out: ExpandedChild[] = [];
  for (const item of list) {
    if (out.length >= max) break;
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const label = typeof raw.label === "string" ? raw.label.trim() : typeof raw.title === "string" ? raw.title.trim() : "";
    if (!label) continue;
    const key = normalizeLabel(label);
    if (seen.has(key)) continue;
    seen.add(key);
    const description = typeof raw.description === "string" && raw.description.trim() ? raw.description.trim() : undefined;
    const child: ExpandedChild = description ? { label, description } : { label };
    if (Array.isArray(raw.sources) && raw.sources.length) child.sources = raw.sources;
    out.push(child);
  }
  return out;
}

/**
 * Returns a new normalized tree with `children` appended under `nodeId` (after any it already
 * has, so existing ids don't move) and the node's `hasMore` cleared. Doesn't mutate `root`.
 * Returns null if the node isn't in this tree.
 */
export function appendMindMapChildren(root: MindMapItem, nodeId: string, children: ExpandedChild[]): MindMapItem | null {
  const copy: MindMapItem = JSON.parse(JSON.stringify(root));
  const found = findMindMapNode(copy, nodeId);
  if (!found) return null;
  delete found.node.hasMore;
  // Raw model `sources` ride along untyped here; the normalizeMindMap below validates them.
  found.node.children.push(...children.map((c) => ({ id: "", ...c, children: [] }) as unknown as MindMapItem));
  // Re-normalizing assigns the new children their `<parent>.<n>` ids and depth, and would trim
  // anything over MIND_MAP_LIMITS — MindMapSvc already capped `children` so nothing is cut here.
  return normalizeMindMap(copy) ?? null;
}

/** Returns a new normalized tree with the node's label (and, when given, description — "" clears
 * it) replaced. Doesn't mutate `root`; null if the node isn't in this tree. */
export function renameMindMapNode(
  root: MindMapItem,
  nodeId: string,
  change: { label: string; description?: string },
): MindMapItem | null {
  const copy: MindMapItem = JSON.parse(JSON.stringify(root));
  const found = findMindMapNode(copy, nodeId);
  if (!found) return null;
  found.node.label = change.label;
  // Jev judged the old text against its passage — that verdict says nothing about the new one.
  delete found.node.check;
  if (change.description !== undefined) {
    if (change.description) found.node.description = change.description;
    else delete found.node.description;
  }
  return normalizeMindMap(copy) ?? null;
}

/** Returns a new normalized tree without the node and everything under it. Siblings keep their
 * ids (see childIds in response-parser.ts). Doesn't mutate `root`; null if the node isn't in this
 * tree or is the root. */
export function deleteMindMapNode(root: MindMapItem, nodeId: string): MindMapItem | null {
  const copy: MindMapItem = JSON.parse(JSON.stringify(root));
  const found = findMindMapNode(copy, nodeId);
  if (!found?.parent) return null;
  found.parent.children = found.parent.children.filter((c) => c !== found.node);
  return normalizeMindMap(copy) ?? null;
}

/** Drops `sources` entries whose documentId isn't one of the case's READY documents (the model
 * can mistype or invent ids). Mutates `tree`; returns how many were dropped. */
export function keepOnlyCaseSources(tree: MindMapItem, allowed: Set<string>): number {
  let dropped = 0;
  const walk = (node: MindMapItem) => {
    if (node.sources) {
      const kept = node.sources.filter((s) => allowed.has(s.documentId));
      dropped += node.sources.length - kept.length;
      if (kept.length) node.sources = kept;
      else delete node.sources;
    }
    node.children.forEach(walk);
  };
  walk(tree);
  return dropped;
}

/**
 * For a map that isn't being rebuilt (someone expanded it): drops citations to documents no
 * longer in `current`, marks those points `sourceRemoved`, and clears a Jev check made against a
 * removed document. Returns a new normalized tree and how many points changed, or null when
 * nothing cites a removed document. Doesn't mutate `root`.
 */
export function syncRemovedSources(root: MindMapItem, current: Set<string>): { tree: MindMapItem; changed: number } | null {
  const copy: MindMapItem = JSON.parse(JSON.stringify(root));
  let changed = 0;
  const walk = (node: MindMapItem) => {
    const citesRemoved = node.sources?.some((s) => !current.has(s.documentId)) ?? false;
    // Only a verdict reached on a cited page depends on that document; a case-data one doesn't.
    const checkRemoved = node.check?.documentId ? !current.has(node.check.documentId) : false;
    if (citesRemoved || checkRemoved) {
      const kept = (node.sources ?? []).filter((s) => current.has(s.documentId));
      if (kept.length) node.sources = kept;
      else delete node.sources;
      if (checkRemoved) delete node.check;
      node.sourceRemoved = true;
      changed++;
    }
    node.children.forEach(walk);
  };
  walk(copy);
  return changed ? { tree: normalizeMindMap(copy) ?? copy, changed } : null;
}

