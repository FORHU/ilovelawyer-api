import { choice } from "@typesafe-ai/sdk";
import DocumentChunkRepo from "../repositories/document-chunk.repository";
import DocumentChunkSvc from "../services/document-chunk.service";
import { getTypeSafeClient } from "./typesafeClient";
import { MindMapItem, MindMapNodeCheck, normalizeMindMap } from "./response-parser";
import logger from "./logger";

/**
 * Jev as the verifier behind the case mind map, the same way it verifies the Red Team's arguments
 * (red-team-jev.ts): the map builder (CaseMindMapSvc / an expand) writes the points; Jev then
 * judges each point against the case data — the lawyer's findings, key dates, contradictions,
 * witnesses, parties and damages, i.e. what the Red Team is judged against — plus the page it
 * cites when it cites one. One Jev request per point, points in parallel. Jev doesn't write
 * anything; a verdict is stored on the node and shown to the lawyer, never used to change the map.
 *
 * Judging against the case data rather than only a cited page is what lets every point be
 * checked: a point doesn't need a document citation to be borne out (or contradicted) by the case.
 *
 * Off unless USE_JEV_MINDMAP=true — gated like the other Jev pilots until
 * scripts/jev-mind-map-benchmark.ts has been run against lawyer-labelled nodes.
 */
export function isMindMapJevEnabled(): boolean {
  return process.env.USE_JEV_MINDMAP === "true";
}

export const SUPPORT_VERDICTS = ["SUPPORTED", "UNSUPPORTED", "CONTRADICTED"] as const;
export type SupportVerdict = (typeof SUPPORT_VERDICTS)[number];

/** Same floor and reason as red-team-jev.ts: CONTRADICTED is the accusatory verdict, so below
 * this it's reported as UNSUPPORTED. Provisional — re-set from the mind-map benchmark. */
export const CONTRADICTION_MIN_CONFIDENCE = 0.7;

/** Points checked per build. A full map can hold 150; checking every one would cost more than the
 * build did, so the main points (shallowest first) get checked. */
export const MIND_MAP_JEV_MAX_NODES = 60;
/** Jev calls in flight at once — this runs in the background after every build, not on a lawyer
 * waiting for an answer. */
const CONCURRENCY = 5;
/** Characters of the cited page(s) handed to Jev, same budget as the grounding check. */
const PASSAGE_BUDGET = 3500;
// Caps on each case-data list handed to Jev per point — same idea and size as red-team-jev.ts's.
const MAX_CONTEXT_ITEMS = 25;
/** Actions to take, not statements about the case: nothing in the case data can bear them out, so
 * every one would come back UNSUPPORTED and be flagged for no reason. */
const UNCHECKED_BRANCHES = new Set(["nextSteps"]);

/** The case data a point is judged against (built by CaseMindMapSvc from the case snapshot, the
 * same source the Red Team uses). */
export interface MindMapJevContext {
  parties: string[];
  legalIssues: string[];
  strengths: string[];
  weaknesses: string[];
  contradictions: string[];
  timeline: string[];
  witnesses: string[];
  damages: string[];
}

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

function clip<T>(items: T[]): T[] {
  return items.slice(0, MAX_CONTEXT_ITEMS);
}

/** A point to check, with the label of the first-level branch it sits under (Key Facts, Risks…),
 * which tells Jev what kind of statement it is. */
export interface MindMapPointToCheck {
  node: MindMapItem;
  branch: string;
}

/** What Jev said about one point, before it's stored (see checkMindMapNode). */
export interface MindMapPointJudgement {
  verdict: SupportVerdict;
  confidence: number;
  /** Jev's own answer, before the CONTRADICTED floor. */
  rawVerdict: SupportVerdict;
  downgraded: boolean;
}

/**
 * The Jev call itself: `point` judged against `context`, plus `cited` (the page it cites) when
 * given. Takes its inputs directly so scripts/jev-mind-map-benchmark.ts scores exactly what a
 * build runs. Throws on a Jev failure.
 */
export async function judgeMindMapPoint(
  point: { branch: string; text: string },
  context: MindMapJevContext,
  cited?: { document: string; text: string },
): Promise<MindMapPointJudgement> {
  const client = getTypeSafeClient();
  const state = {
    point,
    ...(cited ? { citedPassage: cited } : {}),
    caseData: {
      parties: clip(context.parties),
      legalIssues: clip(context.legalIssues),
      strengths: clip(context.strengths),
      weaknesses: clip(context.weaknesses),
      contradictions: clip(context.contradictions),
      timeline: clip(context.timeline),
      witnesses: clip(context.witnesses),
      damages: clip(context.damages),
    },
  };
  const sources = cited ? "`caseData` and `citedPassage`" : "`caseData`";
  const response = await client.systemOne({
    state,
    questions: {
      support: choice(
        `\`point\` is a point on the case's strategy map, under the \`point.branch\` heading. Classify the relationship between ${sources} and what \`point.text\` states: SUPPORTED if they bear it out, even if worded differently; UNSUPPORTED if they do not address or do not establish it; CONTRADICTED if they say the opposite of it. Do not use facts that are not in the state.`,
        { SUPPORTED: null, UNSUPPORTED: null, CONTRADICTED: null },
      ),
    },
  });
  const s = response.answers.support;
  const rawVerdict: SupportVerdict = (SUPPORT_VERDICTS as readonly string[]).includes(s.choice as string)
    ? (s.choice as SupportVerdict)
    : "UNSUPPORTED";
  const downgraded = rawVerdict === "CONTRADICTED" && s.confidence < CONTRADICTION_MIN_CONFIDENCE;
  return { verdict: downgraded ? "UNSUPPORTED" : rawVerdict, confidence: s.confidence, rawVerdict, downgraded };
}

/**
 * Judges one point of a saved map: loads the page it cites (when it cites one) and asks Jev
 * (judgeMindMapPoint). Throws on a Jev failure; the caller decides what an unchecked point means.
 */
export async function checkMindMapNode(
  point: MindMapPointToCheck,
  context: MindMapJevContext,
  documentName?: string,
): Promise<MindMapNodeCheck> {
  const { node, branch } = point;
  const source = node.sources?.[0];
  const cited = source ? await loadCitedPassage(node) : null;
  logger.info("Jev request", { feature: "mind-map", nodeId: node.id, branch, cited: Boolean(cited) });
  const judged = await judgeMindMapPoint(
    { branch, text: nodeAssertion(node) },
    context,
    cited && source
      ? {
          document: [documentName ?? "the cited document", source.page ? `p. ${source.page}` : null].filter(Boolean).join(", "),
          text: cited.passage,
        }
      : undefined,
  );
  const check: MindMapNodeCheck = {
    verdict: judged.verdict,
    confidence: judged.confidence,
    basis: cited ? "document" : "caseData",
    checkedAt: new Date().toISOString(),
  };
  if (cited && source) {
    check.documentId = source.documentId;
    check.located = cited.located;
    if (source.page) check.page = source.page;
  }
  logger.info("Jev response", {
    feature: "mind-map",
    nodeId: node.id,
    verdict: check.verdict,
    confidence: check.confidence,
    basis: check.basis,
    // Logged so a floor-triggered downgrade is visible in the trace, not mistaken for UNSUPPORTED.
    rawVerdict: judged.rawVerdict,
    downgraded: judged.downgraded,
  });
  return check;
}

/** Which points to check: everything below the five branches except Next Steps (actions, see
 * UNCHECKED_BRANCHES), optionally only `onlyIds`, shallowest first (the main points before their
 * detail), capped at `max` (the benchmark's export passes Infinity to label them all). */
export function nodesToCheck(tree: MindMapItem, onlyIds?: Set<string>, max: number = MIND_MAP_JEV_MAX_NODES): MindMapPointToCheck[] {
  const out: MindMapPointToCheck[] = [];
  const walk = (node: MindMapItem, depth: number, branch: MindMapItem | null) => {
    if (depth >= 2 && (!onlyIds || onlyIds.has(node.id))) out.push({ node, branch: branch!.label });
    for (const child of node.children) {
      const childBranch = depth === 0 ? child : branch;
      if (depth === 0 && UNCHECKED_BRANCHES.has(child.id)) continue;
      walk(child, depth + 1, childBranch);
    }
  };
  walk(tree, 0, null);
  return out.sort((a, b) => (a.node.depth ?? 0) - (b.node.depth ?? 0)).slice(0, max);
}

/** A check, plus the exact text it judged — so a verdict is only ever attached to the text Jev
 * actually saw (see applyMindMapChecks). */
export interface MindMapCheckResult {
  nodeId: string;
  assertion: string;
  check: MindMapNodeCheck;
}

/** Checks `points`, CONCURRENCY at a time. A point whose Jev call fails is left unchecked and
 * logged, never marked — "we couldn't check" must not read as a verdict. */
export async function checkMindMapNodes(
  points: MindMapPointToCheck[],
  context: MindMapJevContext,
  documentNames: Map<string, string>,
): Promise<MindMapCheckResult[]> {
  const results: MindMapCheckResult[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, points.length) }, async () => {
      for (;;) {
        const point = points[next++];
        if (!point) return;
        try {
          const documentId = point.node.sources?.[0]?.documentId;
          const check = await checkMindMapNode(point, context, documentId ? documentNames.get(documentId) : undefined);
          results.push({ nodeId: point.node.id, assertion: nodeAssertion(point.node), check });
        } catch (err) {
          logger.warn("Mind map Jev check failed, leaving the node unchecked", { err, nodeId: point.node.id });
        }
      }
    }),
  );
  return results;
}

/**
 * Returns a new normalized tree with each result attached to its node — but only when the node
 * still exists, still says exactly what Jev checked (someone may have renamed it while the checks
 * ran) and, for a verdict reached on a cited page, still cites that document. Doesn't mutate
 * `tree`; `applied` is how many landed.
 */
export function applyMindMapChecks(tree: MindMapItem, results: MindMapCheckResult[]): { tree: MindMapItem; applied: number } {
  const copy: MindMapItem = JSON.parse(JSON.stringify(tree));
  const byId = new Map(results.map((r) => [r.nodeId, r]));
  let applied = 0;
  const walk = (node: MindMapItem) => {
    const result = byId.get(node.id);
    const sameSource = !result?.check.documentId || node.sources?.[0]?.documentId === result.check.documentId;
    if (result && nodeAssertion(node) === result.assertion && sameSource) {
      node.check = result.check;
      applied++;
    }
    node.children.forEach(walk);
  };
  walk(copy);
  return { tree: normalizeMindMap(copy) ?? copy, applied };
}
