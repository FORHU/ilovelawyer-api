import { expect } from "chai";
import { describe, it } from "mocha";
import {
  extractMindMap,
  parseStructuredDataPayload,
  normalizeMindMap,
  stripStructuredBlocks,
  MindMapItem,
} from "../src/utils/response-parser";
import { MIND_MAP_LIMITS } from "../src/constants/mind-map-limits.constants";

const tree = {
  id: "root",
  label: "Illegal dismissal",
  isRoot: true,
  children: [
    { id: "facts", label: "Key Facts", children: [{ id: "f1", label: "No notice", children: [] }] },
    { id: "law", label: "Legal Basis", children: [] },
  ],
};

describe("response-parser — mind map", () => {
  it("parses Chat Wonder [STRUCTURED_DATA] timeline + mindMap", () => {
    const parsed = parseStructuredDataPayload(
      JSON.stringify({
        timeline: [{ title: "File complaint", description: "NLRC", status: "pending" }],
        mindMap: tree,
      }),
    );
    expect(parsed.mindMap?.label).to.equal("Illegal dismissal");
    expect(parsed.mindMap?.children).to.have.length(2);
    expect(parsed.timeline).to.have.length(1);
  });

  it("unwraps a nested root object", () => {
    const parsed = normalizeMindMap({ root: tree });
    expect(parsed?.id).to.equal("root");
    expect(parsed?.children?.[0]?.label).to.equal("Key Facts");
  });

  it("still extracts inline [MINDMAP] tags", () => {
    const text = `Here is the analysis.\n[MINDMAP]\n${JSON.stringify(tree)}\n[/MINDMAP]`;
    const map = extractMindMap(text);
    expect(map?.label).to.equal("Illegal dismissal");
    expect(stripStructuredBlocks(text)).to.not.include("Illegal dismissal");
  });

  it("gives nodes stable path-based ids and keeps the model's id as sourceId", () => {
    const map = normalizeMindMap(tree)!;
    expect(map.id).to.equal("root");
    expect(map.isRoot).to.equal(true);
    expect(map.depth).to.equal(0);
    const [facts, law] = map.children;
    expect(facts.id).to.equal("keyFacts");
    expect(facts.sourceId).to.equal("facts");
    expect(facts.depth).to.equal(1);
    expect(law.id).to.equal("legalBasis");
    expect(facts.children[0].id).to.equal("keyFacts.1");
    expect(facts.children[0].sourceId).to.equal("f1");
    expect(facts.children[0].depth).to.equal(2);
  });

  it("produces the same ids when the model picks different ones for the same tree", () => {
    const rerun = {
      id: "case-root-xyz",
      label: "Illegal dismissal",
      children: [
        { id: "n-8841", label: "Key Facts", children: [{ id: "n-9", label: "No notice", children: [] }] },
        { id: "n-8842", label: "legal_basis", children: [] },
      ],
    };
    const ids = (m: MindMapItem): string[] => [m.id, ...m.children.flatMap(ids)];
    expect(ids(normalizeMindMap(rerun)!)).to.deep.equal(ids(normalizeMindMap(tree)!));
  });

  it("is idempotent", () => {
    const once = normalizeMindMap(tree)!;
    expect(normalizeMindMap(once)).to.deep.equal(once);
  });

  it("names non-fixed or duplicate first-level branches by position", () => {
    const map = normalizeMindMap({
      id: "root",
      label: "Case",
      children: [
        { id: "x", label: "Risks", children: [] },
        { id: "y", label: "Risks", children: [] },
        { id: "z", label: "Procedural History", children: [{ label: "Filed 2025", children: [] }] },
      ],
    })!;
    expect(map.children.map((c) => c.id)).to.deep.equal(["risks", "b2", "b3"]);
    expect(map.children[2].children[0].id).to.equal("b3.1");
  });

  it("accepts the renderer's child-key aliases and label fallbacks", () => {
    const map = normalizeMindMap({ label: "Case", items: [{ text: "Key Facts", nodes: [{ title: "Signed 3 Mar" }] }] })!;
    expect(map.children[0].label).to.equal("Key Facts");
    expect(map.children[0].children[0].label).to.equal("Signed 3 Mar");
    expect(map.children[0].children[0].children).to.deep.equal([]);
  });

  it(`stops at depth ${MIND_MAP_LIMITS.maxDepth} and marks the cut node hasMore`, () => {
    let deepest: any = { label: "leaf", children: [] };
    for (let i = MIND_MAP_LIMITS.maxDepth + 2; i > 0; i--) deepest = { label: `level ${i}`, children: [deepest] };
    let node = normalizeMindMap({ label: "Case", children: [deepest] })!;
    let levels = 0;
    while (node.children.length) {
      node = node.children[0];
      levels++;
    }
    expect(levels).to.equal(MIND_MAP_LIMITS.maxDepth);
    expect(node.depth).to.equal(MIND_MAP_LIMITS.maxDepth);
    expect(node.hasMore).to.equal(true);
  });

  it(`keeps at most ${MIND_MAP_LIMITS.maxNodes} nodes, breadth-first`, () => {
    const wide = {
      label: "Case",
      children: Array.from({ length: 5 }, (_, b) => ({
        label: `Branch ${b}`,
        children: Array.from({ length: 40 }, (_, c) => ({ label: `Leaf ${b}.${c}`, children: [] })),
      })),
    };
    const map = normalizeMindMap(wide)!;
    const count = (m: MindMapItem): number => 1 + m.children.reduce((n, c) => n + count(c), 0);
    expect(count(map)).to.equal(MIND_MAP_LIMITS.maxNodes);
    // All five first-level branches survive; the cut falls in the last branch's leaves.
    expect(map.children).to.have.length(5);
    expect(map.children[4].hasMore).to.equal(true);
    expect(map.children[0].hasMore).to.equal(undefined);
  });

  it("strips a leaked [STRUCTURED_DATA] frame from chat text", () => {
    const text = `Answer.\n[STRUCTURED_DATA]${JSON.stringify({ mindMap: tree })}[DONE]`;
    expect(stripStructuredBlocks(text)).to.equal("Answer.");
  });
});
