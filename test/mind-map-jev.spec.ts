/**
 * Jev checking the case mind map's points (mind-map-jev.ts) the way it checks the Red Team's
 * arguments: each point judged against the case data, plus the page it cites when it cites one;
 * and the verdicts saved (CaseMindMapSvc.checkCaseMap). Jev itself is stubbed at
 * TypeSafeClient.prototype.systemOne, same as red-team-jev.spec.ts — this is about what Jev is
 * asked, which points get checked, and where the verdict lands. No DB: repository statics are
 * monkeypatched.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import { TypeSafeClient } from "@typesafe-ai/sdk";

import DocumentChunkRepo from "../src/repositories/document-chunk.repository";
import DocumentChunkSvc from "../src/services/document-chunk.service";
import DocumentRepo from "../src/repositories/document.repository";
import MindMapRepo, { MindMapVersionConflictError } from "../src/repositories/mind-map.repository";
import CaseMindMapSvc from "../src/services/case-mind-map.service";
import {
  applyMindMapChecks,
  checkMindMapNode,
  checkMindMapNodes,
  CONTRADICTION_MIN_CONFIDENCE,
  loadCitedPassage,
  MIND_MAP_JEV_MAX_NODES,
  MindMapJevContext,
  nodesToCheck,
} from "../src/utils/mind-map-jev";
import { MindMapItem, normalizeMindMap } from "../src/utils/response-parser";
import { findMindMapNode, renameMindMapNode, syncRemovedSources } from "../src/utils/mind-map-tree";

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
          children: [{ label: "No payment by 1 June", children: [] }],
        },
      ],
    },
    { id: "keyFacts", label: "Key Facts", children: [{ label: "Loan of 500,000", children: [] }] },
    { id: "nextSteps", label: "Next Steps", children: [{ label: "Send a final demand", children: [] }] },
  ],
})!;

const context: MindMapJevContext = {
  parties: ["Cruz (plaintiff)", "Reyes (defendant)"],
  legalIssues: ["Default on the note"],
  strengths: ["Signed note"],
  weaknesses: [],
  contradictions: [],
  timeline: ["2026-06-01 — Loan due"],
  witnesses: [],
  damages: ["Unpaid principal"],
};

const point = (id: string) => nodesToCheck(map).find((p) => p.node.id === id)!;

describe("mind-map-jev", () => {
  const originals: [any, string, unknown][] = [];
  const patch = (target: any, key: string, value: unknown) => {
    originals.push([target, key, target[key]]);
    target[key] = value;
  };
  const originalSystemOne = TypeSafeClient.prototype.systemOne;
  let requests: { state: any; question: string }[];
  let reply: (text: string) => { choice: string; confidence: number } | Error;

  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    requests = [];
    reply = () => ({ choice: "SUPPORTED", confidence: 0.93 });
    (TypeSafeClient.prototype as any).systemOne = async (req: { state: any; questions: { support: any } }) => {
      const question = JSON.stringify(req.questions.support);
      requests.push({ state: req.state, question });
      const answer = reply(req.state.point.text);
      if (answer instanceof Error) throw answer;
      return { answers: { support: answer } };
    };
    patch(DocumentChunkRepo, "findTextsByPage", async (_doc: string, page: number) => (page === 2 ? ["Payable on 1 June 2026.", "Signed 3 March."] : []));
    patch(DocumentChunkSvc, "relevantChunksForDocument", async () => ({ caseDocumentIds: [DOC], caseDocumentChunkIds: ["c9"] }));
    patch(DocumentChunkRepo, "findTextsByIds", async () => [{ id: "c9", caseDocumentId: DOC, chunkText: "No payment was received.", chunkIndex: 9, pageNumber: 5 }]);
  });

  afterEach(() => {
    TypeSafeClient.prototype.systemOne = originalSystemOne;
    while (originals.length) {
      const [target, key, value] = originals.pop()!;
      target[key] = value;
    }
  });

  describe("loadCitedPassage", () => {
    it("reads the cited page, else falls back to the document's most relevant passages", async () => {
      expect(await loadCitedPassage(findMindMapNode(map, "legalBasis.1")!.node)).to.deep.equal({
        passage: "Payable on 1 June 2026.\nSigned 3 March.",
        located: true,
      });
      const unpaged = { ...findMindMapNode(map, "legalBasis.1")!.node, sources: [{ documentId: DOC }] };
      expect(await loadCitedPassage(unpaged)).to.deep.equal({ passage: "No payment was received.", located: false });
      expect(await loadCitedPassage(findMindMapNode(map, "keyFacts.1")!.node)).to.equal(null);
    });
  });

  describe("checkMindMapNode", () => {
    it("judges an uncited point against the case data alone, like a Red Team argument", async () => {
      const check = await checkMindMapNode(point("keyFacts.1"), context);
      expect(requests[0].state.point).to.deep.equal({ branch: "Key Facts", text: "Loan of 500,000" });
      expect(requests[0].state.caseData).to.include.keys("legalIssues", "strengths", "timeline", "damages");
      expect(requests[0].state).to.not.have.property("citedPassage");
      expect(requests[0].question).to.contain("`caseData`").and.not.contain("citedPassage");
      expect(check).to.include({ verdict: "SUPPORTED", basis: "caseData" });
      expect(check).to.not.have.property("documentId");
    });

    it("adds the page a point cites, naming the document", async () => {
      const check = await checkMindMapNode(point("legalBasis.1"), context, "Promissory note.pdf");
      expect(requests[0].state.citedPassage).to.deep.equal({
        document: "Promissory note.pdf, p. 2",
        text: "Payable on 1 June 2026.\nSigned 3 March.",
      });
      expect(requests[0].question).to.contain("`citedPassage`");
      expect(check).to.include({ basis: "document", documentId: DOC, page: 2, located: true });
    });

    it(`reports a CONTRADICTED under ${CONTRADICTION_MIN_CONFIDENCE} confidence as UNSUPPORTED (the Red Team's floor)`, async () => {
      reply = () => ({ choice: "CONTRADICTED", confidence: CONTRADICTION_MIN_CONFIDENCE - 0.1 });
      expect((await checkMindMapNode(point("keyFacts.1"), context)).verdict).to.equal("UNSUPPORTED");
      reply = () => ({ choice: "CONTRADICTED", confidence: 0.9 });
      expect((await checkMindMapNode(point("keyFacts.1"), context)).verdict).to.equal("CONTRADICTED");
    });
  });

  describe("nodesToCheck", () => {
    it("every point below the branches except Next Steps, main points first, optionally only some", () => {
      expect(nodesToCheck(map).map((p) => [p.node.id, p.branch])).to.deep.equal([
        ["legalBasis.1", "Legal Basis"],
        ["keyFacts.1", "Key Facts"],
        ["legalBasis.1.1", "Legal Basis"],
      ]);
      expect(nodesToCheck(map, new Set(["legalBasis.1.1"])).map((p) => p.node.id)).to.deep.equal(["legalBasis.1.1"]);
    });

    it(`caps at ${MIND_MAP_JEV_MAX_NODES}`, () => {
      const big = normalizeMindMap({
        label: "Case",
        children: [{ id: "keyFacts", label: "Key Facts", children: Array.from({ length: 100 }, (_, i) => ({ label: `p${i}`, children: [] })) }],
      })!;
      expect(nodesToCheck(big)).to.have.length(MIND_MAP_JEV_MAX_NODES);
      expect(nodesToCheck(big, undefined, Infinity)).to.have.length(100);
    });
  });

  it("checkMindMapNodes leaves a point unchecked when its Jev call fails, rather than marking it", async () => {
    reply = (text) => (text === "Loan of 500,000" ? new Error("Jev unavailable") : { choice: "SUPPORTED", confidence: 0.9 });
    const results = await checkMindMapNodes(nodesToCheck(map), context, new Map());
    expect(results.map((r) => r.nodeId).sort()).to.deep.equal(["legalBasis.1", "legalBasis.1.1"]);
  });

  describe("applyMindMapChecks", () => {
    const check = { verdict: "UNSUPPORTED" as const, confidence: 0.8, basis: "document" as const, documentId: DOC, page: 2, located: true, checkedAt: "2026-09-25T00:00:00.000Z" };
    const result = { nodeId: "legalBasis.1", assertion: "Loan due 1 June. The note sets the due date.", check };

    it("attaches the verdict and survives a re-normalize", () => {
      const { tree, applied } = applyMindMapChecks(map, [result]);
      expect(applied).to.equal(1);
      expect(findMindMapNode(normalizeMindMap(tree)!, "legalBasis.1")!.node.check).to.deep.equal(check);
      expect(findMindMapNode(map, "legalBasis.1")!.node.check).to.equal(undefined);
    });

    it("skips a point renamed while the check ran, or a page verdict whose point now cites another document", () => {
      const renamed = renameMindMapNode(map, "legalBasis.1", { label: "Loan due 1 July" })!;
      expect(applyMindMapChecks(renamed, [result]).applied).to.equal(0);
      const recited: any = JSON.parse(JSON.stringify(map));
      findMindMapNode(recited, "legalBasis.1")!.node.sources = [{ documentId: OTHER }];
      expect(applyMindMapChecks(recited, [result]).applied).to.equal(0);
    });

    it("a case-data verdict doesn't depend on any document", () => {
      const caseData = { nodeId: "keyFacts.1", assertion: "Loan of 500,000", check: { verdict: "SUPPORTED" as const, confidence: 0.9, basis: "caseData" as const, checkedAt: "" } };
      const { tree, applied } = applyMindMapChecks(map, [caseData]);
      expect(applied).to.equal(1);
      // Removing every document leaves it in place; only page verdicts go with their document.
      const withPage = applyMindMapChecks(tree, [result]).tree;
      const synced = syncRemovedSources(withPage, new Set())!.tree;
      expect(findMindMapNode(synced, "keyFacts.1")!.node.check?.basis).to.equal("caseData");
      expect(findMindMapNode(synced, "legalBasis.1")!.node.check).to.equal(undefined);
    });

    it("renaming a checked point clears its verdict", () => {
      const checked = applyMindMapChecks(map, [result]).tree;
      expect(findMindMapNode(renameMindMapNode(checked, "legalBasis.1", { label: "Changed" })!, "legalBasis.1")!.node.check).to.equal(undefined);
    });

    it("normalizeMindMap keeps an older document check, and drops a malformed one", () => {
      const older = { verdict: "SUPPORTED", confidence: 0.9, evidenceKind: "SHOWN_BY_DOCUMENT", documentId: DOC, located: true, checkedAt: "" };
      const tree = normalizeMindMap({
        label: "C",
        children: [
          { label: "old", check: older, children: [] },
          { label: "bad", check: { verdict: "MAYBE", basis: "caseData" }, children: [] },
          { label: "no doc", check: { verdict: "SUPPORTED", basis: "document" }, children: [] },
        ],
      })!;
      expect(tree.children[0].check).to.include({ basis: "document", documentId: DOC, evidenceKind: "SHOWN_BY_DOCUMENT" });
      expect(tree.children[1].check).to.equal(undefined);
      expect(tree.children[2].check).to.equal(undefined);
    });
  });

  describe("CaseMindMapSvc.checkCaseMap", () => {
    let row: { id: string; data: MindMapItem; version: number };
    let saves: { reason: string; data: MindMapItem; nodeId?: string; userId?: string }[];
    let conflictOnce: boolean;
    let contextUsers: string[];

    beforeEach(() => {
      process.env.USE_JEV_MINDMAP = "true";
      row = { id: "cmm1", data: map, version: 3 };
      saves = [];
      conflictOnce = false;
      contextUsers = [];
      patch(CaseMindMapSvc, "jevContext", async (_caseId: string, userId: string) => {
        contextUsers.push(userId);
        return context;
      });
      patch(DocumentRepo, "listAllByCase", async () => [{ id: DOC, name: "Promissory note.pdf", ragStatus: "READY" }]);
      patch(MindMapRepo, "findCaseMap", async () => ({ ...row }));
      patch(MindMapRepo, "saveNewVersion", async (p: any) => {
        if (conflictOnce) {
          conflictOnce = false;
          // Someone renamed a checked point in the meantime.
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

    it("checks every point against the case data read as the user, and saves the verdicts as a 'check' version", async () => {
      reply = () => ({ choice: "CONTRADICTED", confidence: 0.9 });
      expect(await CaseMindMapSvc.checkCaseMap("case-1", "u1")).to.equal(3);
      expect(contextUsers).to.deep.equal(["u1"]);
      expect(saves).to.have.length(1);
      expect(saves[0]).to.include({ reason: "check", nodeId: undefined, userId: undefined });
      expect(findMindMapNode(row.data, "keyFacts.1")!.node.check).to.include({ verdict: "CONTRADICTED", basis: "caseData" });
      expect(findMindMapNode(row.data, "nextSteps.1")!.node.check).to.equal(undefined);
      expect(requests.find((r) => r.state.citedPassage?.document.startsWith("Promissory note.pdf"))).to.not.equal(undefined);
    });

    it("only checks the given points (an expand's new points)", async () => {
      expect(await CaseMindMapSvc.checkCaseMap("case-1", "u1", new Set(["legalBasis.1.1"]))).to.equal(1);
      expect(requests).to.have.length(1);
    });

    it("re-applies onto a map that moved on, dropping the verdict for a point renamed meanwhile", async () => {
      conflictOnce = true;
      expect(await CaseMindMapSvc.checkCaseMap("case-1", "u1")).to.equal(2);
      expect(findMindMapNode(row.data, "legalBasis.1")!.node.check).to.equal(undefined);
      expect(findMindMapNode(row.data, "legalBasis.1.1")!.node.check?.verdict).to.equal("SUPPORTED");
    });

    it("does nothing unless USE_JEV_MINDMAP=true", async () => {
      delete process.env.USE_JEV_MINDMAP;
      expect(await CaseMindMapSvc.checkCaseMap("case-1", "u1")).to.equal(0);
      expect(requests).to.have.length(0);
      expect(saves).to.have.length(0);
    });

    it("checkInBackground skips a build no user started (nobody to read the case data as)", async () => {
      let ran = false;
      patch(CaseMindMapSvc, "checkCaseMap", async () => {
        ran = true;
        return 0;
      });
      CaseMindMapSvc.checkInBackground("case-1", undefined);
      await new Promise((r) => setTimeout(r, 5));
      expect(ran).to.equal(false);
    });
  });
});
