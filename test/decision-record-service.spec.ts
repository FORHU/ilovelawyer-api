/** DecisionRecordSvc — the case-graph promotion and user-facing dispute/list actions for
 * Decision Records (differentiation program, Phase 1). No live Postgres: DecisionRecordRepo,
 * CaseGraphSvc, CaseEdgeRepo, CaseAccess and OrganizationRepo are monkeypatched on their
 * CommonJS module objects, same idiom as test/message-persistence-durability.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import DecisionRecordSvc from "../src/services/decision-record.service";
import DecisionRecordRepo from "../src/repositories/decision-record.repository";
import CaseGraphSvc from "../src/services/case-graph.service";
import CaseEdgeRepo from "../src/repositories/case-edge.repository";
import CaseAccess from "../src/utils/case-access";
import OrganizationRepo from "../src/repositories/organization.repository";
import AnnotationRepo from "../src/repositories/annotation.repository";
import { DecisionRecordItem } from "../src/utils/response-parser";

function record(over: Partial<DecisionRecordItem> = {}): DecisionRecordItem {
  return {
    anchor: "The absence of the through-ties was a substantial cause of the collapse.",
    conclusion: "The missing ties caused the collapse.",
    rule: [{ title: "CMCHA 2007, s 1", url: "https://juris.ph/case/abc", verified: true }],
    evidenceFor: [{ doc: "D01", docId: "doc-1", pinpoint: "para 10", quote: "east tie line", verified: true }],
    evidenceAgainst: [{ doc: "D09", docId: "doc-9", pinpoint: "Part 2", quote: null, verified: true }],
    alternatives: [],
    weighting: "The survey outweighs disputed recollection.",
    confidence: "high",
    wouldChangeIf: ["The ties were found intact"],
    ...over,
  };
}

describe("DecisionRecordSvc.promote", () => {
  const originals = {
    create: DecisionRecordRepo.create,
    ensureNode: CaseGraphSvc.ensureNode,
    edgeCreate: CaseEdgeRepo.create,
  };
  let createdRows: any[];
  let nodeCalls: { caseId: string; nodeType: string; refId: string }[];
  let edgeCalls: any[];
  let nodeCounter = 0;

  beforeEach(() => {
    createdRows = [];
    nodeCalls = [];
    edgeCalls = [];
    nodeCounter = 0;
    (DecisionRecordRepo as any).create = async (caseId: string, data: any) => {
      const row = { id: `dr-${createdRows.length + 1}`, caseId, ...data };
      createdRows.push(row);
      return row;
    };
    (CaseGraphSvc as any).ensureNode = async (caseId: string, nodeType: string, refId: string) => {
      nodeCalls.push({ caseId, nodeType, refId });
      nodeCounter += 1;
      return { id: `node-${nodeType}-${refId}` };
    };
    (CaseEdgeRepo as any).create = async (caseId: string, data: any) => {
      edgeCalls.push({ caseId, ...data });
      return { id: `edge-${edgeCalls.length}` };
    };
  });

  afterEach(() => {
    (DecisionRecordRepo as any).create = originals.create;
    (CaseGraphSvc as any).ensureNode = originals.ensureNode;
    (CaseEdgeRepo as any).create = originals.edgeCreate;
  });

  it("does nothing for an empty case id or record list", async () => {
    expect(await DecisionRecordSvc.promote("", "msg-1", [record()])).to.deep.equal({ count: 0 });
    expect(await DecisionRecordSvc.promote("case-1", "msg-1", [])).to.deep.equal({ count: 0 });
    expect(createdRows).to.have.length(0);
  });

  it("creates one DecisionRecord row per record, authored by no one (AI)", async () => {
    const result = await DecisionRecordSvc.promote("case-1", "msg-1", [record(), record({ anchor: "A second conclusion." })]);
    expect(result.count).to.equal(2);
    expect(createdRows).to.have.length(2);
    expect(createdRows[0]).to.include({ caseId: "case-1", sourceMessageId: "msg-1", authorUserId: null });
    expect(createdRows[0].anchor).to.equal(record().anchor);
  });

  it("registers a DECISION graph node and DOCUMENT nodes for verified evidence", async () => {
    await DecisionRecordSvc.promote("case-1", "msg-1", [record()]);
    const decisionNodes = nodeCalls.filter((n) => n.nodeType === "DECISION");
    const documentNodes = nodeCalls.filter((n) => n.nodeType === "DOCUMENT");
    expect(decisionNodes).to.have.length(1);
    expect(decisionNodes[0].refId).to.equal("dr-1");
    expect(documentNodes.map((n) => n.refId)).to.have.members(["doc-1", "doc-9"]);
  });

  it("links evidenceFor as SUPPORTS and evidenceAgainst as CONTRADICTS", async () => {
    await DecisionRecordSvc.promote("case-1", "msg-1", [record()]);
    expect(edgeCalls).to.have.length(2);
    const supports = edgeCalls.find((e) => e.relationType === "SUPPORTS");
    const contradicts = edgeCalls.find((e) => e.relationType === "CONTRADICTS");
    expect(supports.targetEntityId).to.equal("node-DOCUMENT-doc-1");
    expect(supports.sourceEntityId).to.equal("node-DECISION-dr-1");
    expect(contradicts.targetEntityId).to.equal("node-DOCUMENT-doc-9");
  });

  it("skips evidence with no resolved docId — nothing real to link to", async () => {
    await DecisionRecordSvc.promote(
      "case-1",
      "msg-1",
      [record({ evidenceFor: [{ doc: "D99", docId: null, pinpoint: "x", quote: null, verified: false }], evidenceAgainst: [] })],
    );
    expect(edgeCalls).to.have.length(0);
  });

  it("dedupes duplicate evidence items pointing at the same document and relation", async () => {
    await DecisionRecordSvc.promote(
      "case-1",
      "msg-1",
      [
        record({
          evidenceFor: [
            { doc: "D01", docId: "doc-1", pinpoint: "para 10", quote: "a", verified: true },
            { doc: "D01", docId: "doc-1", pinpoint: "para 11", quote: "b", verified: true },
          ],
          evidenceAgainst: [],
        }),
      ],
    );
    expect(edgeCalls).to.have.length(1);
  });

  it("keeps each record's DECISION node distinct so cross-record edges never collide", async () => {
    await DecisionRecordSvc.promote("case-1", "msg-1", [record(), record({ anchor: "Second." })]);
    const decisionNodeIds = nodeCalls.filter((n) => n.nodeType === "DECISION").map((n) => n.refId);
    expect(new Set(decisionNodeIds).size).to.equal(2);
  });

  it("survives a duplicate-edge race (unique constraint) without throwing", async () => {
    (CaseEdgeRepo as any).create = async () => {
      throw Object.assign(new Error("unique constraint"), { code: "P2002" });
    };
    const result = await DecisionRecordSvc.promote("case-1", "msg-1", [record()]);
    expect(result.count).to.equal(1);
  });
});

describe("DecisionRecordSvc — dispute / reactivate / list", () => {
  const originals = {
    loadAccessibleCase: CaseAccess.loadAccessibleCase,
    assertCanEdit: CaseAccess.assertCanEdit,
    list: DecisionRecordRepo.list,
    updateStatus: DecisionRecordRepo.updateStatus,
    writeAudit: OrganizationRepo.writeAudit,
    annotationCreate: AnnotationRepo.create,
  };
  let audits: any[];
  let annotations: any[];

  beforeEach(() => {
    audits = [];
    annotations = [];
    (CaseAccess as any).loadAccessibleCase = async () => ({ id: "case-1" });
    (CaseAccess as any).assertCanEdit = async () => ({ id: "case-1" });
    (OrganizationRepo as any).writeAudit = async (data: any) => {
      audits.push(data);
    };
    (AnnotationRepo as any).create = async (caseId: string, data: any) => {
      const row = { id: `ann-${annotations.length + 1}`, caseId, ...data };
      annotations.push(row);
      return row;
    };
  });

  afterEach(() => {
    (CaseAccess as any).loadAccessibleCase = originals.loadAccessibleCase;
    (CaseAccess as any).assertCanEdit = originals.assertCanEdit;
    (DecisionRecordRepo as any).list = originals.list;
    (DecisionRecordRepo as any).updateStatus = originals.updateStatus;
    (OrganizationRepo as any).writeAudit = originals.writeAudit;
    (AnnotationRepo as any).create = originals.annotationCreate;
  });

  it("list checks case access and forwards the status filter", async () => {
    let seenArgs: any[] = [];
    (DecisionRecordRepo as any).list = async (...args: any[]) => {
      seenArgs = args;
      return [{ id: "dr-1" }];
    };
    const rows = await DecisionRecordSvc.list("case-1", "user-1", "DISPUTED" as any);
    expect(rows).to.deep.equal([{ id: "dr-1" }]);
    expect(seenArgs).to.deep.equal(["case-1", "DISPUTED"]);
  });

  it("dispute requires edit access, sets DISPUTED with the note, and writes an audit event", async () => {
    let seenArgs: any[] = [];
    (DecisionRecordRepo as any).updateStatus = async (...args: any[]) => {
      seenArgs = args;
      return { id: "dr-1", status: "DISPUTED", disputeNote: args[3] };
    };
    const row = await DecisionRecordSvc.dispute("case-1", "dr-1", "user-1", "I read D08 differently.");
    expect(seenArgs).to.deep.equal(["dr-1", "case-1", "DISPUTED", "I read D08 differently."]);
    expect(row.disputeNote).to.equal("I read D08 differently.");
    expect(audits).to.have.length(1);
    expect(audits[0]).to.include({ caseId: "case-1", actorId: "user-1", action: "decision.dispute" });
    expect(annotations).to.have.length(1);
    expect(annotations[0]).to.include({
      caseId: "case-1",
      authorUserId: "user-1",
      targetType: "DECISION",
      targetId: "dr-1",
      kind: "DISPUTE",
      body: "I read D08 differently.",
    });
  });

  it("dispute writes a fallback annotation body when no note is given", async () => {
    (DecisionRecordRepo as any).updateStatus = async () => ({ id: "dr-1", status: "DISPUTED", disputeNote: null });
    await DecisionRecordSvc.dispute("case-1", "dr-1", "user-1");
    expect(annotations[0].body).to.equal("Disputed, no note given.");
  });

  it("dispute throws 404 when the record does not exist in this case", async () => {
    (DecisionRecordRepo as any).updateStatus = async () => null;
    let threw: any;
    try {
      await DecisionRecordSvc.dispute("case-1", "missing", "user-1");
    } catch (e) {
      threw = e;
    }
    expect(threw).to.exist;
    expect(threw.status ?? threw.statusCode).to.equal(404);
  });

  it("reactivate sets ACTIVE and clears any dispute note (via null third status arg passthrough)", async () => {
    let seenArgs: any[] = [];
    (DecisionRecordRepo as any).updateStatus = async (...args: any[]) => {
      seenArgs = args;
      return { id: "dr-1", status: "ACTIVE", disputeNote: null };
    };
    await DecisionRecordSvc.reactivate("case-1", "dr-1", "user-1");
    expect(seenArgs.slice(0, 3)).to.deep.equal(["dr-1", "case-1", "ACTIVE"]);
    expect(audits[0].action).to.equal("decision.reactivate");
  });
});
