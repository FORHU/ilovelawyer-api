/**
 * Stage 6: Jev checking the case mind map's cited points (mind-map-jev.ts) and saving the verdicts
 * (CaseMindMapSvc.checkCaseMap). Jev itself is stubbed — checkAssertionWithJev's own behaviour is
 * covered by the grounding benchmark; this is about which passage it's given, which nodes get
 * checked, and where the verdict lands. No DB: repository statics are monkeypatched.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";

import * as assertionCheck from "../src/utils/assertion-check";
import DocumentChunkRepo from "../src/repositories/document-chunk.repository";
import DocumentChunkSvc from "../src/services/document-chunk.service";
import DocumentRepo from "../src/repositories/document.repository";
import MindMapRepo, { MindMapVersionConflictError } from "../src/repositories/mind-map.repository";
import CaseMindMapSvc from "../src/services/case-mind-map.service";
import {
  applyMindMapChecks,
  checkMindMapNode,
  checkMindMapNodes,
  loadCitedPassage,
  MIND_MAP_JEV_MAX_NODES,
  nodesToCheck,
} from "../src/utils/mind-map-jev";
import { MindMapItem, normalizeMindMap } from "../src/utils/response-parser";
import { findMindMapNode, renameMindMapNode } from "../src/utils/mind-map-tree";

const DOC = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

const map = normalizeMindMap({
  id: "root",
  label: "Cruz v. Reyes",
  children: [
    {
      id: "legalBasis",
      label: "Legal Basis",
      children: [
        {
          label: "Loan due 1 June",
          description: "The note sets the due date.",
          sources: [{ documentId: DOC, page: 2 }],
          children: [{ label: "No payment by 1 June", sources: [{ documentId: DOC }], children: [] }],
        },
      ],
    },
    { id: "keyFacts", label: "Key Facts", children: [{ label: "Uncited point", children: [] }] },
  ],
})!;

describe("mind-map-jev", () => {
  const originals: [any, string, unknown][] = [];
  const patch = (target: any, key: string, value: unknown) => {
    originals.push([target, key, target[key]]);
    target[key] = value;
  };
  let jevCalls: { assertion: string; passage: string; citation?: string }[];
  let jevVerdict: assertionCheck.AssertionVerdict;

  beforeEach(() => {
    jevCalls = [];
    jevVerdict = "SUPPORTED";
    patch(DocumentChunkRepo, "findTextsByPage", async (_doc: string, page: number) => (page === 2 ? ["Payable on 1 June 2026.", "Signed 3 March."] : []));
    patch(DocumentChunkSvc, "relevantChunksForDocument", async () => ({ caseDocumentIds: [DOC], caseDocumentChunkIds: ["c9"] }));
    patch(DocumentChunkRepo, "findTextsByIds", async () => [{ id: "c9", caseDocumentId: DOC, chunkText: "No payment was received.", chunkIndex: 9, pageNumber: 5 }]);
    patch(assertionCheck, "checkAssertionWithJev", async (assertion: string, passage: string, citation?: string) => {
      jevCalls.push({ assertion, passage, citation });
      return { verdict: jevVerdict, confidence: 0.93, evidenceKind: "SHOWN_BY_DOCUMENT", kindConfidence: 0.9, notes: "" };
    });
  });

  afterEach(() => {
    while (originals.length) {
      const [target, key, value] = originals.pop()!;
      target[key] = value;
    }
  });

  describe("loadCitedPassage", () => {
    it("uses the text on the cited page, marked located", async () => {
      const node = findMindMapNode(map, "legalBasis.1")!.node;
      expect(await loadCitedPassage(node)).to.deep.equal({ passage: "Payable on 1 June 2026.\nSigned 3 March.", located: true });
    });

    it("falls back to the document's most relevant chunks when no page is cited, marked not located", async () => {
      const node = findMindMapNode(map, "legalBasis.1.1")!.node;
      expect(await loadCitedPassage(node)).to.deep.equal({ passage: "No payment was received.", located: false });
    });

    it("falls back when the cited page has no text, and gives up when nothing is found", async () => {
      const wrongPage: MindMapItem = { id: "x", label: "x", sources: [{ documentId: DOC, page: 40 }], children: [] };
      expect((await loadCitedPassage(wrongPage))?.located).to.equal(false);
      patch(DocumentChunkRepo, "findTextsByIds", async () => []);
      expect(await loadCitedPassage(wrongPage)).to.equal(null);
      expect(await loadCitedPassage(findMindMapNode(map, "keyFacts.1")!.node)).to.equal(null);
    });
  });

  it("checkMindMapNode asks Jev about the node's text against the passage, citing the document by name", async () => {
    const check = await checkMindMapNode(findMindMapNode(map, "legalBasis.1")!.node, "Promissory note.pdf");
    expect(jevCalls[0]).to.deep.equal({
      assertion: "Loan due 1 June. The note sets the due date.",
      passage: "Payable on 1 June 2026.\nSigned 3 March.",
      citation: "Promissory note.pdf, p. 2",
    });
    expect(check).to.include({ verdict: "SUPPORTED", evidenceKind: "SHOWN_BY_DOCUMENT", documentId: DOC, page: 2, located: true });
  });

  describe("nodesToCheck", () => {
    it("only cited nodes, deepest first, optionally only some", () => {
      expect(nodesToCheck(map).map((n) => n.id)).to.deep.equal(["legalBasis.1.1", "legalBasis.1"]);
      expect(nodesToCheck(map, new Set(["legalBasis.1"])).map((n) => n.id)).to.deep.equal(["legalBasis.1"]);
    });

    it(`caps at ${MIND_MAP_JEV_MAX_NODES}`, () => {
      const big = normalizeMindMap({
        label: "Case",
        children: [{ label: "Legal Basis", children: Array.from({ length: 100 }, (_, i) => ({ label: `p${i}`, sources: [{ documentId: DOC }], children: [] })) }],
      })!;
      expect(nodesToCheck(big)).to.have.length(MIND_MAP_JEV_MAX_NODES);
    });
  });

  it("checkMindMapNodes leaves a node unchecked when its Jev call fails, rather than marking it", async () => {
    let calls = 0;
    patch(assertionCheck, "checkAssertionWithJev", async () => {
      calls++;
      if (calls === 1) throw new Error("Jev unavailable");
      return { verdict: "SUPPORTED", confidence: 0.9, evidenceKind: "SHOWN_BY_DOCUMENT", kindConfidence: 0.9, notes: "" };
    });
    const results = await checkMindMapNodes(nodesToCheck(map), new Map());
    expect(results).to.have.length(1);
  });

  describe("applyMindMapChecks", () => {
    const check = { verdict: "UNSUPPORTED" as const, confidence: 0.8, evidenceKind: "ASSERTED_BY_PARTY", documentId: DOC, page: 2, located: true, checkedAt: "2026-09-25T00:00:00.000Z" };
    const result = { nodeId: "legalBasis.1", assertion: "Loan due 1 June. The note sets the due date.", check };

    it("attaches the verdict and survives a re-normalize", () => {
      const { tree, applied } = applyMindMapChecks(map, [result]);
      expect(applied).to.equal(1);
      expect(findMindMapNode(normalizeMindMap(tree)!, "legalBasis.1")!.node.check).to.deep.equal(check);
      expect(findMindMapNode(map, "legalBasis.1")!.node.check).to.equal(undefined);
    });

    it("skips a node renamed while the check ran, or one that now cites another document", () => {
      const renamed = renameMindMapNode(map, "legalBasis.1", { label: "Loan due 1 July" })!;
      expect(applyMindMapChecks(renamed, [result]).applied).to.equal(0);
      const recited: any = JSON.parse(JSON.stringify(map));
      findMindMapNode(recited, "legalBasis.1")!.node.sources = [{ documentId: OTHER }];
      expect(applyMindMapChecks(recited, [result]).applied).to.equal(0);
    });

    it("renaming a checked node clears its verdict", () => {
      const checked = applyMindMapChecks(map, [result]).tree;
      expect(findMindMapNode(renameMindMapNode(checked, "legalBasis.1", { label: "Changed" })!, "legalBasis.1")!.node.check).to.equal(undefined);
    });

    it("normalizeMindMap drops a malformed check", () => {
      const tree = normalizeMindMap({ label: "C", children: [{ label: "x", check: { verdict: "MAYBE", documentId: DOC, evidenceKind: "X" }, children: [] }] })!;
      expect(tree.children[0].check).to.equal(undefined);
    });
  });

  describe("CaseMindMapSvc.checkCaseMap", () => {
    let row: { id: string; data: MindMapItem; version: number };
    let saves: { reason: string; data: MindMapItem; nodeId?: string; userId?: string }[];
    let conflictOnce: boolean;

    beforeEach(() => {
      process.env.USE_JEV_MINDMAP = "true";
      row = { id: "cmm1", data: map, version: 3 };
      saves = [];
      conflictOnce = false;
      patch(DocumentRepo, "listAllByCase", async () => [{ id: DOC, name: "Promissory note.pdf", ragStatus: "READY" }]);
      patch(MindMapRepo, "findCaseMap", async () => ({ ...row }));
      patch(MindMapRepo, "saveNewVersion", async (p: any) => {
        if (conflictOnce) {
          conflictOnce = false;
          // Someone renamed a checked node in the meantime.
          row = { ...row, data: renameMindMapNode(row.data, "legalBasis.1", { label: "Renamed meanwhile" })!, version: row.version + 1 };
          throw new MindMapVersionConflictError();
        }
        expect(p.expectedVersion).to.equal(row.version);
        saves.push({ reason: p.reason, data: p.data, nodeId: p.nodeId, userId: p.userId });
        row = { ...row, data: p.data, version: row.version + 1 };
        return { version: row.version };
      });
    });

    afterEach(() => {
      delete process.env.USE_JEV_MINDMAP;
    });

    it("checks every cited node and saves the verdicts as a 'check' version with no user", async () => {
      jevVerdict = "CONTRADICTED";
      expect(await CaseMindMapSvc.checkCaseMap("case-1")).to.equal(2);
      expect(saves).to.have.length(1);
      expect(saves[0]).to.include({ reason: "check", nodeId: undefined, userId: undefined });
      expect(findMindMapNode(row.data, "legalBasis.1")!.node.check?.verdict).to.equal("CONTRADICTED");
      expect(jevCalls.find((c) => c.citation?.startsWith("Promissory note.pdf"))).to.not.equal(undefined);
    });

    it("only checks the given nodes (an expand's new points)", async () => {
      expect(await CaseMindMapSvc.checkCaseMap("case-1", new Set(["legalBasis.1.1"]))).to.equal(1);
      expect(jevCalls).to.have.length(1);
    });

    it("re-applies onto a map that moved on, dropping the verdict for a node renamed meanwhile", async () => {
      conflictOnce = true;
      expect(await CaseMindMapSvc.checkCaseMap("case-1")).to.equal(1);
      expect(findMindMapNode(row.data, "legalBasis.1")!.node.check).to.equal(undefined);
      expect(findMindMapNode(row.data, "legalBasis.1.1")!.node.check?.verdict).to.equal("SUPPORTED");
    });

    it("does nothing unless USE_JEV_MINDMAP=true", async () => {
      delete process.env.USE_JEV_MINDMAP;
      expect(await CaseMindMapSvc.checkCaseMap("case-1")).to.equal(0);
      expect(jevCalls).to.have.length(0);
      expect(saves).to.have.length(0);
    });
  });
});
