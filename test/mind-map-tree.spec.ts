import { expect } from "chai";
import { describe, it } from "mocha";
import { normalizeMindMap, MindMapItem } from "../src/utils/response-parser";
import {
  appendMindMapChildren,
  countMindMapNodes,
  deleteMindMapNode,
  findMindMapNode,
  parseExpandedChildren,
  renameMindMapNode,
  syncRemovedSources,
} from "../src/utils/mind-map-tree";
import MindMapSvc from "../src/services/mind-map.service";
import { MIND_MAP_LIMITS } from "../src/constants/mind-map-limits.constants";

const map = normalizeMindMap({
  id: "r",
  label: "Unpaid loan",
  children: [
    {
      id: "m-legal",
      label: "Legal Basis",
      children: [
        { id: "m-1170", label: "Art. 1170 breach", children: [] },
        { id: "m-2176", label: "Art. 2176 quasi-delict", children: [] },
      ],
    },
    { id: "m-facts", label: "Key Facts", children: [{ id: "m-f1", label: "Signed 3 March", children: [] }] },
  ],
})!;

describe("mind-map-tree", () => {
  describe("findMindMapNode", () => {
    it("finds a node by path id, with its path and parent", () => {
      const found = findMindMapNode(map, "legalBasis.2")!;
      expect(found.node.label).to.equal("Art. 2176 quasi-delict");
      expect(found.path.map((n) => n.id)).to.deep.equal(["root", "legalBasis", "legalBasis.2"]);
      expect(found.parent?.id).to.equal("legalBasis");
    });

    it("finds a node by the model id an older client still holds", () => {
      expect(findMindMapNode(map, "m-1170")?.node.id).to.equal("legalBasis.1");
    });

    it("returns null for an unknown id", () => {
      expect(findMindMapNode(map, "nope")).to.equal(null);
    });
  });

  it("counts every node, root included", () => {
    expect(countMindMapNodes(map)).to.equal(6);
  });

  describe("parseExpandedChildren", () => {
    const tagged = (json: string) => `[MINDMAP_CHILDREN]${json}[/MINDMAP_CHILDREN]`;

    it("reads the tagged block", () => {
      const out = parseExpandedChildren(
        tagged('[{"label":"Demand letter 10 May","description":"Sent by counsel."},{"label":"No reply"}]'),
        [],
        5,
      );
      expect(out).to.deep.equal([{ label: "Demand letter 10 May", description: "Sent by counsel." }, { label: "No reply" }]);
    });

    it("tolerates prose around the block, an unclosed tag, and {children:[...]}", () => {
      expect(parseExpandedChildren('Sure.\n[MINDMAP_CHILDREN]\n[{"label":"A"}]', [], 5)).to.have.length(1);
      expect(parseExpandedChildren('{"children":[{"label":"A"},{"title":"B"}]}', [], 5).map((c) => c.label)).to.deep.equal(["A", "B"]);
    });

    it("drops blanks, repeats of existing labels, and duplicates within the reply", () => {
      const out = parseExpandedChildren(
        tagged('[{"label":""},{"label":"art. 1170 breach!"},{"label":"New point"},{"label":"new  point"}]'),
        ["Art. 1170 breach"],
        5,
      );
      expect(out.map((c) => c.label)).to.deep.equal(["New point"]);
    });

    it("returns at most max", () => {
      expect(parseExpandedChildren(tagged('[{"label":"A"},{"label":"B"},{"label":"C"}]'), [], 2)).to.have.length(2);
    });

    it("returns [] for unparseable output", () => {
      expect(parseExpandedChildren("I could not find anything.", [], 3)).to.deep.equal([]);
    });
  });

  describe("appendMindMapChildren", () => {
    it("appends after existing children with the next path ids and depth", () => {
      const next = appendMindMapChildren(map, "legalBasis", [{ label: "Estoppel" }, { label: "Unjust enrichment", description: "x" }])!;
      const legal = findMindMapNode(next, "legalBasis")!.node;
      expect(legal.children.map((c) => c.id)).to.deep.equal(["legalBasis.1", "legalBasis.2", "legalBasis.3", "legalBasis.4"]);
      expect(legal.children[3]).to.include({ label: "Unjust enrichment", description: "x", depth: 2 });
      expect(legal.children[3].sourceId).to.equal(undefined);
    });

    it("clears hasMore on the expanded node and doesn't touch the input tree", () => {
      const withMore: MindMapItem = JSON.parse(JSON.stringify(map));
      findMindMapNode(withMore, "keyFacts.1")!.node.hasMore = true;
      const before = JSON.stringify(withMore);
      const next = appendMindMapChildren(withMore, "keyFacts.1", [{ label: "Witnessed by notary" }])!;
      expect(findMindMapNode(next, "keyFacts.1")!.node.hasMore).to.equal(undefined);
      expect(findMindMapNode(next, "keyFacts.1.1")!.node.label).to.equal("Witnessed by notary");
      expect(JSON.stringify(withMore)).to.equal(before);
    });

    it("resolves a legacy model id to the right node", () => {
      const next = appendMindMapChildren(map, "m-f1", [{ label: "Notarised" }])!;
      expect(findMindMapNode(next, "keyFacts.1.1")!.node.label).to.equal("Notarised");
    });

    it("returns null when the node isn't there", () => {
      expect(appendMindMapChildren(map, "risks.9", [{ label: "x" }])).to.equal(null);
    });
  });

  describe("MindMapSvc.roomFor (Map expansion limits)", () => {
    it("caps the request to what's left under the node cap", () => {
      expect(MindMapSvc.roomFor(map, findMindMapNode(map, "legalBasis")!.node, 5)).to.equal(5);

      let wide: any = { label: "Case", children: [] };
      for (let i = 0; i < MIND_MAP_LIMITS.maxNodes - 3; i++) wide.children.push({ label: `n${i}`, children: [] });
      wide = normalizeMindMap(wide);
      expect(countMindMapNodes(wide)).to.equal(MIND_MAP_LIMITS.maxNodes - 2);
      expect(MindMapSvc.roomFor(wide, wide.children[0], 5)).to.equal(2);
    });

    it("refuses with MAX_NODES at the cap", () => {
      let full: any = { label: "Case", children: [] };
      for (let i = 0; i < MIND_MAP_LIMITS.maxNodes - 1; i++) full.children.push({ label: `n${i}`, children: [] });
      full = normalizeMindMap(full);
      expect(() => MindMapSvc.roomFor(full, full.children[0], 3))
        .to.throw()
        .with.property("code", "MAX_NODES");
    });

    it("refuses with MAX_DEPTH on a node at the last level", () => {
      const node: MindMapItem = { id: "x", label: "deep", depth: MIND_MAP_LIMITS.maxDepth, children: [] };
      expect(() => MindMapSvc.roomFor(map, node, 3))
        .to.throw()
        .with.property("code", "MAX_DEPTH");
    });
  });

  describe("edits keep ids stable", () => {
    const withThree = appendMindMapChildren(map, "legalBasis", [{ label: "Estoppel" }])!; // legalBasis.1..3

    it("deleting a node doesn't renumber the siblings after it", () => {
      const next = deleteMindMapNode(withThree, "legalBasis.2")!;
      expect(findMindMapNode(next, "legalBasis")!.node.children.map((c) => [c.id, c.label])).to.deep.equal([
        ["legalBasis.1", "Art. 1170 breach"],
        ["legalBasis.3", "Estoppel"],
      ]);
    });

    it("a point added after a delete takes the next number, not the gap", () => {
      const next = appendMindMapChildren(deleteMindMapNode(withThree, "legalBasis.2")!, "legalBasis", [{ label: "Laches" }])!;
      expect(findMindMapNode(next, "legalBasis.4")!.node.label).to.equal("Laches");
      expect(findMindMapNode(next, "legalBasis.2")).to.equal(null);
    });

    it("deleting removes the whole subtree and refuses the root", () => {
      const deep = appendMindMapChildren(map, "keyFacts.1", [{ label: "Notarised" }])!;
      const next = deleteMindMapNode(deep, "keyFacts.1")!;
      expect(findMindMapNode(next, "keyFacts.1.1")).to.equal(null);
      expect(countMindMapNodes(next)).to.equal(countMindMapNodes(map) - 1);
      expect(deleteMindMapNode(map, "root")).to.equal(null);
    });

    it("renames, and an empty description clears it", () => {
      const described = renameMindMapNode(map, "legalBasis.1", { label: "Breach of contract", description: "Art. 1170" })!;
      expect(findMindMapNode(described, "legalBasis.1")!.node).to.include({ label: "Breach of contract", description: "Art. 1170" });
      const cleared = renameMindMapNode(described, "legalBasis.1", { label: "Breach", description: "" })!;
      expect(findMindMapNode(cleared, "legalBasis.1")!.node.description).to.equal(undefined);
      expect(renameMindMapNode(map, "nope", { label: "x" })).to.equal(null);
    });
  });

  describe("syncRemovedSources", () => {
    const cited = normalizeMindMap({
      label: "Case",
      children: [
        {
          label: "Legal Basis",
          children: [
            {
              label: "Two sources",
              sources: [{ documentId: "keep" }, { documentId: "gone", page: 2 }],
              check: { verdict: "SUPPORTED", confidence: 0.9, evidenceKind: "SHOWN_BY_DOCUMENT", documentId: "gone", located: true, checkedAt: "" },
              children: [],
            },
            { label: "Only the gone one", sources: [{ documentId: "gone" }], children: [] },
            { label: "Only kept", sources: [{ documentId: "keep" }], children: [] },
          ],
        },
      ],
    })!;

    it("drops citations to removed documents, clears a check against one, and marks the point", () => {
      const result = syncRemovedSources(cited, new Set(["keep"]))!;
      expect(result.changed).to.equal(2);
      const [both, gone, kept] = findMindMapNode(result.tree, "legalBasis")!.node.children;
      expect(both).to.deep.include({ sources: [{ documentId: "keep" }], sourceRemoved: true });
      expect(both.check).to.equal(undefined);
      expect(gone.sources).to.equal(undefined);
      expect(gone.sourceRemoved).to.equal(true);
      expect(kept.sourceRemoved).to.equal(undefined);
    });

    it("returns null when nothing cites a removed document", () => {
      expect(syncRemovedSources(cited, new Set(["keep", "gone"]))).to.equal(null);
    });
  });
});
