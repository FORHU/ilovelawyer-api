import DocumentChunkRepo from "../repositories/document-chunk.repository";
import DocumentChunkSvc from "../services/document-chunk.service";
import { checkAssertionWithJev } from "./assertion-check";
import { MindMapItem, MindMapNodeCheck, normalizeMindMap } from "./response-parser";
import logger from "./logger";

/**
 * Jev as the verifier behind the case mind map: the map builder (CaseMindMapSvc / an expand)
 * writes the nodes and cites a document + page for each; Jev then judges each node against the
 * passage it cites, with the same question the chat grounding check asks
 * (checkAssertionWithJev — SUPPORTED / UNSUPPORTED / CONTRADICTED, plus what kind of evidence
 * the passage is). Jev doesn't write anything; a verdict is stored on the node and shown to the
 * lawyer, never used to change the map.
 *
 * Off unless USE_JEV_MINDMAP=true — gated like the other Jev pilots until
 * scripts/jev-mind-map-benchmark.ts has been run against lawyer-labelled nodes.
 */
export function isMindMapJevEnabled(): boolean {
  return process.env.USE_JEV_MINDMAP === "true";
}

/** Nodes checked per document build. A full map can hold 150; checking every one would cost more
 * than the build did, so the most specific points (deepest first) get checked. */
export const MIND_MAP_JEV_MAX_NODES = 60;
/** Jev calls in flight at once — lower than the grounding check's 10 since this runs in the
 * background after every build, not on a lawyer waiting for an answer. */
const CONCURRENCY = 5;
/** Characters of the cited page(s) handed to Jev, same budget as the grounding check. */
const PASSAGE_BUDGET = 3500;

/** The text a node asserts: its label, plus its description when it has one. */
export function nodeAssertion(node: MindMapItem): string {
  return node.description ? `${node.label}. ${node.description}` : node.label;
}

/**
 * The passage a node's first source points at: the text on the cited page when there is one
 * (`located: true`), else the chunks of that document most relevant to the node — weaker
 * evidence, recorded as `located: false`, same as the grounding check's fallback window.
 */
export async function loadCitedPassage(node: MindMapItem): Promise<{ passage: string; located: boolean } | null> {
  const source = node.sources?.[0];
  if (!source) return null;
  if (source.page) {
    const onPage = await DocumentChunkRepo.findTextsByPage(source.documentId, source.page);
    const text = onPage.join("\n").trim();
    if (text) return { passage: text.slice(0, PASSAGE_BUDGET), located: true };
  }
  const { caseDocumentChunkIds } = await DocumentChunkSvc.relevantChunksForDocument(source.documentId, nodeAssertion(node), 5);
  const chunks = await DocumentChunkRepo.findTextsByIds(caseDocumentChunkIds);
  const text = chunks.map((c) => c.chunkText).join("\n").trim();
  return text ? { passage: text.slice(0, PASSAGE_BUDGET), located: false } : null;
}

/** Judges one node against its cited passage. Null when it cites nothing or the passage is empty
 * (nothing to judge against — a guaranteed UNSUPPORTED would only mislead). Throws on a Jev
 * failure; the caller decides what an unchecked node means. */
export async function checkMindMapNode(node: MindMapItem, documentName?: string): Promise<MindMapNodeCheck | null> {
  const source = node.sources?.[0];
  const cited = await loadCitedPassage(node);
  if (!source || !cited) return null;
  const citation = [documentName ?? source.documentId, source.page ? `p. ${source.page}` : null].filter(Boolean).join(", ");
  const result = await checkAssertionWithJev(nodeAssertion(node), cited.passage, citation);
  const check: MindMapNodeCheck = {
    verdict: result.verdict,
    confidence: result.confidence,
    evidenceKind: result.evidenceKind,
    documentId: source.documentId,
    located: cited.located,
    checkedAt: new Date().toISOString(),
  };
  if (source.page) check.page = source.page;
  return check;
}

/** Which nodes to check: ones that cite a source, optionally only `onlyIds`, deepest first (the
 * specific points, not the headings), capped at MIND_MAP_JEV_MAX_NODES. */
export function nodesToCheck(tree: MindMapItem, onlyIds?: Set<string>): MindMapItem[] {
  const out: MindMapItem[] = [];
  const walk = (node: MindMapItem) => {
    if (node.sources?.length && (!onlyIds || onlyIds.has(node.id))) out.push(node);
    node.children.forEach(walk);
  };
  walk(tree);
  return out.sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0)).slice(0, MIND_MAP_JEV_MAX_NODES);
}

/** A check, plus the exact text it judged — so a verdict is only ever attached to the text Jev
 * actually saw (see applyMindMapChecks). */
export interface MindMapCheckResult {
  nodeId: string;
  assertion: string;
  check: MindMapNodeCheck;
}

/** Checks `nodes`, CONCURRENCY at a time. A node whose Jev call fails is left unchecked and
 * logged, never marked — "we couldn't check" must not read as a verdict. */
export async function checkMindMapNodes(nodes: MindMapItem[], documentNames: Map<string, string>): Promise<MindMapCheckResult[]> {
  const results: MindMapCheckResult[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, nodes.length) }, async () => {
      for (;;) {
        const node = nodes[next++];
        if (!node) return;
        try {
          const check = await checkMindMapNode(node, documentNames.get(node.sources![0]!.documentId));
          if (check) results.push({ nodeId: node.id, assertion: nodeAssertion(node), check });
        } catch (err) {
          logger.warn("Mind map Jev check failed, leaving the node unchecked", { err, nodeId: node.id });
        }
      }
    }),
  );
  return results;
}

/**
 * Returns a new normalized tree with each result attached to its node — but only when the node
 * still exists and still says exactly what Jev checked (someone may have renamed it while the
 * checks ran). Doesn't mutate `tree`; `applied` is how many landed.
 */
export function applyMindMapChecks(tree: MindMapItem, results: MindMapCheckResult[]): { tree: MindMapItem; applied: number } {
  const copy: MindMapItem = JSON.parse(JSON.stringify(tree));
  const byId = new Map(results.map((r) => [r.nodeId, r]));
  let applied = 0;
  const walk = (node: MindMapItem) => {
    const result = byId.get(node.id);
    if (result && nodeAssertion(node) === result.assertion && node.sources?.[0]?.documentId === result.check.documentId) {
      node.check = result.check;
      applied++;
    }
    node.children.forEach(walk);
  };
  walk(copy);
  return { tree: normalizeMindMap(copy) ?? copy, applied };
}
