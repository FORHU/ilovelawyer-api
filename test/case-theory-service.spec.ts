/** CaseTheorySvc — CRUD, publish/retire, fork, and the graph-linking side of addClaim
 * (differentiation program, Phase 2). No live Postgres: CaseTheoryRepo, CaseGraphSvc,
 * CaseEdgeRepo, CaseAccess and OrganizationRepo are monkeypatched, same idiom as
 * test/decision-record-service.spec.ts. The AI-generation half (proposeInner, which calls
 * streamChatWonderMessage) is intentionally not unit-tested here — same convention as
 * CaseReconstructionSvc.generateInner, which also has no direct unit test.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import CaseTheorySvc from "../src/services/case-theory.service";
import CaseTheoryRepo from "../src/repositories/case-theory.repository";
import CaseGraphSvc from "../src/services/case-graph.service";
import CaseEdgeRepo from "../src/repositories/case-edge.repository";
import CaseAccess from "../src/utils/case-access";
import OrganizationRepo from "../src/repositories/organization.repository";

function theoryRow(over: Partial<any> = {}) {
  return {
    id: "th-1",
    caseId: "case-1",
    authorUserId: "user-1",
    title: "Structural neglect",
    thesis: "The collapse was caused by known, unaddressed defects.",
    status: "DRAFT",
    forkedFromId: null,
    claims: [],
    assumptions: [],
    openQuestions: [],
    ...over,
  };
}

describe("CaseTheorySvc", () => {
  const originals = {
    loadAccessibleCase: CaseAccess.loadAccessibleCase,
    assertCanEdit: CaseAccess.assertCanEdit,
    list: CaseTheoryRepo.list,
    findById: CaseTheoryRepo.findById,
    create: CaseTheoryRepo.create,
    update: CaseTheoryRepo.update,
    addClaim: CaseTheoryRepo.addClaim,
    addAssumption: CaseTheoryRepo.addAssumption,
    addOpenQuestion: CaseTheoryRepo.addOpenQuestion,
    ensureNode: CaseGraphSvc.ensureNode,
    edgeCreate: CaseEdgeRepo.create,
    writeAudit: OrganizationRepo.writeAudit,
  };
  let rows: Record<string, any>;
  let createdRows: any[];
  let edgeCalls: any[];
  let audits: any[];

  beforeEach(() => {
    rows = { "th-1": theoryRow() };
    createdRows = [];
    edgeCalls = [];
    audits = [];
    (CaseAccess as any).loadAccessibleCase = async () => ({ id: "case-1" });
    (CaseAccess as any).assertCanEdit = async () => ({ id: "case-1" });
    (CaseTheoryRepo as any).list = async (caseId: string) => Object.values(rows).filter((r) => r.caseId === caseId);
    (CaseTheoryRepo as any).findById = async (id: string, caseId: string) => {
      const row = rows[id];
      return row && row.caseId === caseId ? row : null;
    };
    (CaseTheoryRepo as any).create = async (caseId: string, data: any) => {
      const row = theoryRow({ id: `th-${createdRows.length + 2}`, caseId, ...data, claims: [], assumptions: [], openQuestions: [] });
      createdRows.push(row);
      rows[row.id] = row;
      return row;
    };
    (CaseTheoryRepo as any).update = async (id: string, caseId: string, data: any) => {
      if (!rows[id] || rows[id].caseId !== caseId) return null;
      rows[id] = { ...rows[id], ...data };
      return rows[id];
    };
    (CaseTheoryRepo as any).addClaim = async (theoryId: string, data: any) => {
      const claim = { id: `claim-${Math.random()}`, theoryId, ...data };
      if (rows[theoryId]) rows[theoryId].claims.push(claim);
      return claim;
    };
    (CaseTheoryRepo as any).addAssumption = async (theoryId: string, statement: string) => {
      const row = { id: `assum-${Math.random()}`, theoryId, statement };
      if (rows[theoryId]) rows[theoryId].assumptions.push(row);
      return row;
    };
    (CaseTheoryRepo as any).addOpenQuestion = async (theoryId: string, question: string) => {
      const row = { id: `oq-${Math.random()}`, theoryId, question };
      if (rows[theoryId]) rows[theoryId].openQuestions.push(row);
      return row;
    };
    (CaseGraphSvc as any).ensureNode = async (caseId: string, nodeType: string, refId: string) => ({ id: `node-${nodeType}-${refId}` });
    (CaseEdgeRepo as any).create = async (caseId: string, data: any) => {
      edgeCalls.push({ caseId, ...data });
      return { id: `edge-${edgeCalls.length}` };
    };
    (OrganizationRepo as any).writeAudit = async (data: any) => {
      audits.push(data);
    };
  });

  afterEach(() => {
    (CaseAccess as any).loadAccessibleCase = originals.loadAccessibleCase;
    (CaseAccess as any).assertCanEdit = originals.assertCanEdit;
    (CaseTheoryRepo as any).list = originals.list;
    (CaseTheoryRepo as any).findById = originals.findById;
    (CaseTheoryRepo as any).create = originals.create;
    (CaseTheoryRepo as any).update = originals.update;
    (CaseTheoryRepo as any).addClaim = originals.addClaim;
    (CaseTheoryRepo as any).addAssumption = originals.addAssumption;
    (CaseTheoryRepo as any).addOpenQuestion = originals.addOpenQuestion;
    (CaseGraphSvc as any).ensureNode = originals.ensureNode;
    (CaseEdgeRepo as any).create = originals.edgeCreate;
    (OrganizationRepo as any).writeAudit = originals.writeAudit;
  });

  it("create registers a THEORY graph node and writes an audit event", async () => {
    const theory = await CaseTheorySvc.create("case-1", "user-1", { title: "T", thesis: "X" });
    expect(theory.authorUserId).to.equal("user-1");
    expect(theory.status).to.equal("DRAFT");
    expect(audits[0]).to.include({ caseId: "case-1", actorId: "user-1", action: "theory.create" });
  });

  it("update requires the author — a different case member is refused", async () => {
    let threw: any;
    try {
      await CaseTheorySvc.update("case-1", "th-1", "someone-else", { title: "Hijack" });
    } catch (e) {
      threw = e;
    }
    expect(threw).to.exist;
    expect(threw.statusCode ?? threw.status).to.equal(403);
  });

  it("update succeeds for the author", async () => {
    const row = await CaseTheorySvc.update("case-1", "th-1", "user-1", { title: "Revised title" });
    expect(row!.title).to.equal("Revised title");
  });

  it("publish moves DRAFT to ACTIVE, only for the author", async () => {
    const row = await CaseTheorySvc.publish("case-1", "th-1", "user-1");
    expect(row!.status).to.equal("ACTIVE");
    expect(audits[0].action).to.equal("theory.publish");
  });

  it("retire moves to RETIRED", async () => {
    const row = await CaseTheorySvc.retire("case-1", "th-1", "user-1");
    expect(row!.status).to.equal("RETIRED");
  });

  it("an AI-proposed theory (authorUserId null) cannot be edited by anyone — only forked", async () => {
    rows["th-1"] = theoryRow({ authorUserId: null });
    let threw: any;
    try {
      await CaseTheorySvc.publish("case-1", "th-1", "user-1");
    } catch (e) {
      threw = e;
    }
    expect(threw).to.exist;
    expect(threw.statusCode ?? threw.status).to.equal(403);
  });

  it("fork copies title/thesis/claims/assumptions/openQuestions into a new theory owned by the forker", async () => {
    rows["th-1"] = theoryRow({
      authorUserId: null,
      claims: [{ id: "c1", theoryId: "th-1", statement: "The ties were missing", stance: "ASSERTS", graphNodeId: null }],
      assumptions: [{ id: "a1", theoryId: "th-1", statement: "Survey is accurate" }],
      openQuestions: [{ id: "q1", theoryId: "th-1", question: "Who signed off?" }],
    });
    const forked = await CaseTheorySvc.fork("case-1", "th-1", "user-2");
    expect(forked!.authorUserId).to.equal("user-2");
    expect(forked!.forkedFromId).to.equal("th-1");
    expect(forked!.claims).to.have.length(1);
    expect(forked!.claims[0].statement).to.equal("The ties were missing");
    expect(forked!.assumptions).to.have.length(1);
    expect(forked!.openQuestions).to.have.length(1);
    expect(audits.find((a) => a.action === "theory.fork")).to.exist;
  });

  it("addClaim with no graphNodeId creates the claim but links no edge", async () => {
    await CaseTheorySvc.addClaim("case-1", "th-1", "user-1", { statement: "X", stance: "ASSERTS" as any });
    expect(edgeCalls).to.have.length(0);
  });

  it("addClaim with a graphNodeId links SUPPORTS for ASSERTS and CONTRADICTS for DENIES", async () => {
    await CaseTheorySvc.addClaim("case-1", "th-1", "user-1", { statement: "X", stance: "ASSERTS" as any, graphNodeId: "node-doc-1" });
    await CaseTheorySvc.addClaim("case-1", "th-1", "user-1", { statement: "Y", stance: "DENIES" as any, graphNodeId: "node-doc-2" });
    expect(edgeCalls).to.have.length(2);
    expect(edgeCalls[0]).to.include({ relationType: "SUPPORTS", targetEntityId: "node-doc-1" });
    expect(edgeCalls[1]).to.include({ relationType: "CONTRADICTS", targetEntityId: "node-doc-2" });
  });

  it("addClaim is refused for a non-author", async () => {
    let threw: any;
    try {
      await CaseTheorySvc.addClaim("case-1", "th-1", "someone-else", { statement: "X", stance: "ASSERTS" as any });
    } catch (e) {
      threw = e;
    }
    expect(threw).to.exist;
    expect(threw.statusCode ?? threw.status).to.equal(403);
  });

  it("addAssumption and addOpenQuestion append to the theory", async () => {
    await CaseTheorySvc.addAssumption("case-1", "th-1", "user-1", "New assumption");
    await CaseTheorySvc.addOpenQuestion("case-1", "th-1", "user-1", "New question");
    expect(rows["th-1"].assumptions).to.have.length(1);
    expect(rows["th-1"].openQuestions).to.have.length(1);
  });

  it("update/publish/addClaim throw 404 for a theory not in this case", async () => {
    let threw: any;
    try {
      await CaseTheorySvc.publish("case-1", "missing", "user-1");
    } catch (e) {
      threw = e;
    }
    expect(threw).to.exist;
    expect(threw.statusCode ?? threw.status).to.equal(404);
  });
});
