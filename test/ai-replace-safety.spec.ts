/** Automatic case-analysis refresh (#74-#76) may only replace AI-generated CaseFinding /
 * ProcedureItem rows — a lawyer's own manually-created findings/procedure items must never be
 * touched by a refresh, automatic or manual, since both converge on the same
 * replaceAiFindings/replaceAiProcedureItems repository methods. This pins the actual mechanism
 * (the delete's WHERE clause only ever matches AI-authored rows, identified by `notes`) so a
 * future edit that widens that WHERE clause (e.g. to `{ caseId }` alone) fails loudly here
 * instead of quietly deleting a lawyer's work on the next refresh.
 *
 * No live Postgres: prisma's model delegates are monkeypatched directly on the shared client
 * singleton (verified mutable — see src/lib/prisma.ts), same monkeypatch idiom the rest of this
 * suite uses for repositories/services.
 */
import { expect } from "chai";
import { describe, it, afterEach } from "mocha";
import prisma from "../src/lib/prisma";
import CaseFindingRepo from "../src/repositories/case-finding.repository";
import ProceduralDeadlineRepo from "../src/repositories/procedural-deadline.repository";
import { AI_FINDING_NOTE, AI_PROCEDURE_NOTE } from "../src/constants";

describe("CaseFindingRepo.replaceAiFindings", () => {
  const originals = {
    transaction: prisma.$transaction,
    deleteMany: prisma.caseFinding.deleteMany,
    createManyAndReturn: prisma.caseFinding.createManyAndReturn,
    findMany: prisma.caseFinding.findMany,
    nodeDeleteMany: prisma.caseGraphNode.deleteMany,
    nodeCreateMany: prisma.caseGraphNode.createMany,
    procedureUpdateMany: prisma.procedureItem.updateMany,
  };

  afterEach(() => {
    (prisma as any).$transaction = originals.transaction;
    (prisma.caseFinding as any).deleteMany = originals.deleteMany;
    (prisma.caseFinding as any).createManyAndReturn = originals.createManyAndReturn;
    (prisma.caseFinding as any).findMany = originals.findMany;
    (prisma.caseGraphNode as any).deleteMany = originals.nodeDeleteMany;
    (prisma.caseGraphNode as any).createMany = originals.nodeCreateMany;
    (prisma.procedureItem as any).updateMany = originals.procedureUpdateMany;
  });

  // The stale-AI-row lookup selects id/category/label; list() (called at the end) reads whole rows.
  const stubFindMany = (staleIds: string[], listed: any[], stale: any[] = staleIds.map((id) => ({ id, category: "WEAKNESS", label: `stale ${id}` }))) => {
    (prisma.caseFinding as any).findMany = async (args: any) => (args?.select?.id ? stale : listed);
  };
  // Records the to-do re-pointing a refresh does (Case Strategy links follow a regenerated finding).
  const stubProcedureItems = () => {
    const moved: any[] = [];
    (prisma.procedureItem as any).updateMany = async (args: any) => {
      moved.push(args);
      return { count: 1 };
    };
    return moved;
  };
  const stubNodes = () => {
    const calls: { deleted?: any; created: any[] } = { created: [] };
    (prisma.caseGraphNode as any).deleteMany = async (args: any) => {
      calls.deleted = args.where;
      return { count: 0 };
    };
    (prisma.caseGraphNode as any).createMany = async (args: any) => {
      calls.created = args.data;
      return { count: args.data.length };
    };
    return calls;
  };

  it("only deletes AI-authored rows (notes === AI_FINDING_NOTE) — a manual finding's WHERE never matches", async () => {
    let deleteWhere: any;
    let created: any[] = [];
    (prisma as any).$transaction = async (fn: any) => fn(prisma);
    (prisma.caseFinding as any).deleteMany = async (args: any) => {
      deleteWhere = args.where;
      return { count: 1 };
    };
    (prisma.caseFinding as any).createManyAndReturn = async (args: any) => {
      created = args.data;
      return args.data.map((d: any, i: number) => ({ id: `new-${i}`, category: d.category, label: d.label }));
    };
    stubProcedureItems();
    stubFindMany(["ai-old"], [
      { id: "manual-1", notes: "Confirmed with the client directly." },
      { id: "ai-2", notes: AI_FINDING_NOTE },
    ]);
    stubNodes();

    const result = await CaseFindingRepo.replaceAiFindings("case-1", [
      { category: "WEAKNESS", label: "New AI-found weakness", sourceLabel: "D01" },
    ]);

    // The scoping guarantee: the delete's own where-clause structurally can't ever match a
    // manually-authored row (whose notes is never AI_FINDING_NOTE, e.g. a client note or null).
    expect(deleteWhere).to.deep.equal({ caseId: "case-1", notes: AI_FINDING_NOTE });
    expect(created).to.have.length(1);
    expect(created[0]).to.deep.include({ caseId: "case-1", notes: AI_FINDING_NOTE, label: "New AI-found weakness" });
    // list() (called at the end) still returns both the surviving manual row and the fresh AI row.
    expect(result.map((r: any) => r.id)).to.have.members(["manual-1", "ai-2"]);
  });

  it("swaps the graph nodes too — the Legal Issues panel's graph view skips findings with no node", async () => {
    (prisma as any).$transaction = async (fn: any) => fn(prisma);
    (prisma.caseFinding as any).deleteMany = async () => ({ count: 2 });
    (prisma.caseFinding as any).createManyAndReturn = async (args: any) =>
      args.data.map((d: any, i: number) => ({ id: `new-${i}`, category: d.category, label: d.label }));
    stubProcedureItems();
    stubFindMany(["ai-old-1", "ai-old-2"], []);
    const nodes = stubNodes();

    await CaseFindingRepo.replaceAiFindings("case-1", [
      { category: "LEGAL_ISSUE", label: "Whether the dismissal was for redundancy", sourceLabel: null },
      { category: "WEAKNESS", label: "No consultation record", sourceLabel: null },
    ]);

    // Only the replaced AI rows' nodes go — never a manual finding's.
    expect(nodes.deleted).to.deep.equal({ nodeType: "FINDING", refId: { in: ["ai-old-1", "ai-old-2"] } });
    expect(nodes.created).to.deep.equal([
      { caseId: "case-1", nodeType: "FINDING", refId: "new-0" },
      { caseId: "case-1", nodeType: "FINDING", refId: "new-1" },
    ]);
  });

  it("still deletes stale AI rows even when the new batch is empty (nothing left to regenerate)", async () => {
    let deleteWhere: any;
    let createCalled = false;
    (prisma as any).$transaction = async (fn: any) => fn(prisma);
    (prisma.caseFinding as any).deleteMany = async (args: any) => {
      deleteWhere = args.where;
      return { count: 1 };
    };
    (prisma.caseFinding as any).createManyAndReturn = async () => {
      createCalled = true;
      return [];
    };
    stubFindMany(["ai-old"], []);
    const nodes = stubNodes();

    await CaseFindingRepo.replaceAiFindings("case-1", []);

    expect(deleteWhere).to.deep.equal({ caseId: "case-1", notes: AI_FINDING_NOTE });
    expect(createCalled).to.equal(false);
    expect(nodes.deleted).to.deep.equal({ nodeType: "FINDING", refId: { in: ["ai-old"] } });
    expect(nodes.created).to.deep.equal([]);
  });

  it("moves a Case Strategy to-do onto the regenerated copy of its finding, and leaves the rest", async () => {
    (prisma as any).$transaction = async (fn: any) => fn(prisma);
    (prisma.caseFinding as any).deleteMany = async () => ({ count: 2 });
    (prisma.caseFinding as any).createManyAndReturn = async (args: any) =>
      args.data.map((d: any, i: number) => ({ id: `new-${i}`, category: d.category, label: d.label }));
    stubFindMany(["ai-old-1", "ai-old-2"], [], [
      { id: "ai-old-1", category: "WEAKNESS", label: "No written protest from client" },
      { id: "ai-old-2", category: "WEAKNESS", label: "Dropped in this refresh" },
    ]);
    stubNodes();
    const moved = stubProcedureItems();

    await CaseFindingRepo.replaceAiFindings("case-1", [
      { category: "WEAKNESS", label: "No written protest from client ", sourceLabel: null },
    ]);

    expect(moved).to.deep.equal([
      { where: { caseId: "case-1", sourceKind: "FINDING", sourceId: "ai-old-1" }, data: { sourceId: "new-0" } },
    ]);
  });
});

describe("ProceduralDeadlineRepo.replaceAiProcedureItems", () => {
  const originals = {
    transaction: prisma.$transaction,
    deleteMany: prisma.procedureItem.deleteMany,
    createMany: prisma.procedureItem.createMany,
    findMany: prisma.procedureItem.findMany,
  };

  afterEach(() => {
    (prisma as any).$transaction = originals.transaction;
    (prisma.procedureItem as any).deleteMany = originals.deleteMany;
    (prisma.procedureItem as any).createMany = originals.createMany;
    (prisma.procedureItem as any).findMany = originals.findMany;
  });

  it("only ever looks at AI-authored rows (notes === AI_PROCEDURE_NOTE), and keeps a ticked one the run drops", async () => {
    let findWhere: any;
    let deleteWhere: any;
    let created: any[] = [];
    (prisma as any).$transaction = async (fn: any) => fn(prisma);
    (prisma.procedureItem as any).findMany = async (args: any) => {
      if (args?.where?.notes === AI_PROCEDURE_NOTE) {
        findWhere = args.where;
        return [
          { id: "ai-open", kind: "TODO", label: "Stale open idea", done: false, sourceLabel: null },
          { id: "ai-done", kind: "TODO", label: "Ticked earlier", done: true, sourceLabel: null },
        ];
      }
      return [];
    };
    (prisma.procedureItem as any).deleteMany = async (args: any) => {
      deleteWhere = args.where;
      return { count: 1 };
    };
    (prisma.procedureItem as any).createMany = async (args: any) => {
      created = args.data;
      return { count: args.data.length };
    };

    await ProceduralDeadlineRepo.replaceAiProcedureItems("case-1", [
      { kind: "FILING", label: "New AI-found deadline task", sourceLabel: "D02" },
    ]);

    expect(findWhere).to.deep.equal({ caseId: "case-1", notes: AI_PROCEDURE_NOTE });
    expect(deleteWhere).to.deep.equal({ caseId: "case-1", id: { in: ["ai-open"] } });
    expect(created).to.have.length(1);
    expect(created[0]).to.deep.include({ caseId: "case-1", notes: AI_PROCEDURE_NOTE, label: "New AI-found deadline task" });
  });
});

