import { MindMapItem } from "./response-parser";

/**
 * The lawyer's own changes to the case mind map since its last build — the points they added,
 * renamed/redescribed and removed by hand (MindMapSvc.editCaseNode, saved as `reason: "edit"`
 * versions) — and how they're written into a chat turn's context, so chat-wonder answers with the
 * lawyer's current view of the case instead of the map as it was generated.
 *
 * Worked out by replaying the versions since the build, not read off the nodes: every version
 * holds the whole tree, node ids are stable across edits (childIds in response-parser.ts), and an
 * Undo deletes the versions it steps back over, so what's left is exactly what still applies.
 * "expand" versions (AI-written points) and "check"/"sync" versions just move the baseline along.
 */

export interface MindMapLawyerChanges {
  /** Ids of points the lawyer added (still on the map; editing them later keeps them "added"). */
  added: Set<string>;
  /** Ids of generated points whose label or description the lawyer changed. */
  edited: Set<string>;
  /** Generated points the lawyer deleted — the top of each deleted branch, with where it was. */
  removed: { label: string; path: string[] }[];
}

type Indexed = Map<string, { node: MindMapItem; path: string[] }>;

/** Every node by id, with the labels of the nodes above it (root excluded). */
function index(tree: MindMapItem): Indexed {
  const out: Indexed = new Map();
  const walk = (node: MindMapItem, path: string[]) => {
    out.set(node.id, { node, path });
    const below = node.isRoot ? [] : [...path, node.label];
    for (const child of node.children ?? []) walk(child, below);
  };
  walk(tree, []);
  return out;
}

/** `versions`: the build and every version after it, oldest first (MindMapRepo.listCaseVersionsSinceBuild). */
export function lawyerChangesSince(versions: { reason: string; data: unknown }[]): MindMapLawyerChanges {
  const added = new Set<string>();
  const edited = new Set<string>();
  const removed: { id: string; label: string; path: string[] }[] = [];
  for (let i = 1; i < versions.length; i++) {
    if (versions[i].reason !== "edit") continue;
    const before = index(versions[i - 1].data as MindMapItem);
    const after = index(versions[i].data as MindMapItem);
    for (const [id, { node }] of after) {
      const was = before.get(id)?.node;
      if (!was) added.add(id);
      else if (!added.has(id) && (was.label !== node.label || (was.description ?? "") !== (node.description ?? ""))) edited.add(id);
    }
    for (const [id, { node, path }] of before) {
      if (after.has(id)) continue;
      // Only the top of a deleted branch is worth naming; and a point the lawyer added and then
      // deleted again was never part of the generated map, so there's nothing to report.
      const parentGone = !after.has(parentIdOf(id));
      if (!parentGone && !added.has(id)) removed.push({ id, label: node.label, path });
      added.delete(id);
      edited.delete(id);
    }
  }
  return { added, edited, removed: removed.map(({ label, path }) => ({ label, path })) };
}

/** `legalBasis.1.2` → `legalBasis.1`; a first-level id → `root`. */
function parentIdOf(id: string): string {
  const dot = id.lastIndexOf(".");
  return dot === -1 ? "root" : id.slice(0, dot);
}

export function hasLawyerChanges(c: MindMapLawyerChanges): boolean {
  return c.added.size > 0 || c.edited.size > 0 || c.removed.length > 0;
}

const pointText = (label: string, description?: string) => (description ? `${label}: ${description}` : label);

/** Truncates to `max` characters on a line boundary, saying so. */
function capLines(lines: string[], max: number): string {
  let out = "";
  for (const line of lines) {
    if (out.length + line.length + 1 > max) return `${out}…(cut for length)`;
    out += `${line}\n`;
  }
  return out.trimEnd();
}

/**
 * The block every case chat turn carries (in `document_context`) when the lawyer has changed the
 * map: just the changes, not the whole map, so an ordinary turn stays cheap. Empty when there are none.
 */
export function formatLawyerChanges(tree: MindMapItem, changes: MindMapLawyerChanges, maxChars = 2500): string {
  if (!hasLawyerChanges(changes)) return "";
  const nodes = index(tree);
  const line = (id: string) => {
    const hit = nodes.get(id);
    return hit ? `- ${[...hit.path, pointText(hit.node.label, hit.node.description)].join(" › ")}` : null;
  };
  const lines = [
    "## CASE STRATEGY MAP: THE LAWYER'S OWN CHANGES",
    "The lawyer has changed the case's strategy map by hand. Treat these as their current view of the case: build on the points they added or reworded, and don't raise the points they removed as open issues unless they ask about them.",
  ];
  const added = [...changes.added].map(line).filter((l): l is string => Boolean(l));
  const edited = [...changes.edited].map(line).filter((l): l is string => Boolean(l));
  if (added.length) lines.push("Added by the lawyer:", ...added);
  if (edited.length) lines.push("Reworded by the lawyer (as it reads now):", ...edited);
  if (changes.removed.length) {
    lines.push("Removed by the lawyer:", ...changes.removed.map((r) => `- ${[...r.path, r.label].join(" › ")}`));
  }
  return capLines(lines, maxChars);
}

/**
 * The whole current map as an indented outline, with the lawyer's changes marked — sent with a
 * turn that asks for a map (`case_mind_map_context`), so chat-wonder's map builds on the lawyer's
 * map instead of starting over. The removed points come first, so a long map that gets cut at
 * `maxChars` loses its last branches, never those.
 */
export function formatMindMapOutline(tree: MindMapItem, changes: MindMapLawyerChanges, maxChars = 5000): string {
  const lines = [
    "## THE CASE'S CURRENT STRATEGY MAP",
    "Build on this map. Keep the points marked [added by lawyer] or [reworded by lawyer] as they are, and don't bring back the points listed as removed by the lawyer.",
  ];
  if (changes.removed.length) {
    lines.push("Removed by the lawyer:", ...changes.removed.map((r) => `- ${[...r.path, r.label].join(" › ")}`), "Current map:");
  }
  const walk = (node: MindMapItem, depth: number) => {
    if (!node.isRoot) {
      const mark = changes.added.has(node.id) ? " [added by lawyer]" : changes.edited.has(node.id) ? " [reworded by lawyer]" : "";
      lines.push(`${"  ".repeat(depth - 1)}- ${pointText(node.label, node.description)}${mark}`);
    }
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(tree, 0);
  return capLines(lines, maxChars);
}
