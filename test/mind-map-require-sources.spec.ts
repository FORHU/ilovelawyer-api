import { expect } from "chai";
import { describe, it } from "mocha";
import { normalizeMindMap, MindMapItem } from "../src/utils/response-parser";
import { citesCaseDocument, countMindMapNodes, findMindMapNode, requireCaseSourcesBelowHeadings } from "../src/utils/mind-map-tree";

const doc = (documentId: string) => [{ documentId, page: 1 }];

const tree = () =>
  normalizeMindMap({
    id: "root",
    label: "Cruz v. Acme",
    isRoot: true,
    children: [
      {
        id: "legalBasis",
        label: "Legal Basis",
        children: [
          {
            label: "Illegal dismissal",
            // No citation of its own, but its children cite documents.
            children: [
              { label: "No notice to explain", sources: doc("D1"), children: [] },
              { label: "Two-notice rule", children: [] },
            ],
          },
          { label: "Labor Code Art. 297", sources: doc("D2"), children: [] },
        ],
      },
      { id: "remedies", label: "Remedies", children: [{ label: "Moral damages likely", children: [] }] },
    ],
  }) as MindMapItem;

describe("requireCaseSourcesBelowHeadings", () => {
  it("removes every uncited point below the headings, keeping the root and headings", () => {
    const { tree: kept, removed } = requireCaseSourcesBelowHeadings(tree());
    expect(removed).to.equal(3);
    expect(kept.children.map((h) => h.label)).to.deep.equal(["Legal Basis", "Remedies"]);
    const walk = (n: MindMapItem, depth: number): void => {
      if (depth >= 2) expect(n.sources?.length, n.label).to.be.greaterThan(0);
      n.children.forEach((c) => walk(c, depth + 1));
    };
    walk(kept, 0);
  });

  it("moves a cited point up when the point above it cited nothing", () => {
    const { tree: kept } = requireCaseSourcesBelowHeadings(tree());
    expect(kept.children[0]!.children.map((c) => c.label)).to.deep.equal(["No notice to explain", "Labor Code Art. 297"]);
    // Path ids follow the new shape.
    expect(findMindMapNode(kept, kept.children[0]!.children[0]!.id)!.parent!.label).to.equal("Legal Basis");
  });

  it("leaves a heading the documents say nothing about with no children", () => {
    const { tree: kept } = requireCaseSourcesBelowHeadings(tree());
    expect(kept.children[1]!.children).to.deep.equal([]);
  });

  it("changes nothing when every point is cited", () => {
    const { tree: start } = requireCaseSourcesBelowHeadings(tree());
    const again = requireCaseSourcesBelowHeadings(start);
    expect(again.removed).to.equal(0);
    expect(countMindMapNodes(again.tree)).to.equal(countMindMapNodes(start));
  });
});

describe("citesCaseDocument", () => {
  const allowed = new Set(["D1"]);
  it("is true only for a point citing one of the case's documents", () => {
    expect(citesCaseDocument({ label: "a", sources: doc("D1") }, allowed)).to.equal(true);
    expect(citesCaseDocument({ label: "b", sources: doc("D9") }, allowed)).to.equal(false);
    expect(citesCaseDocument({ label: "c" }, allowed)).to.equal(false);
    expect(citesCaseDocument({ label: "d", sources: [null, "x"] }, allowed)).to.equal(false);
  });
});
