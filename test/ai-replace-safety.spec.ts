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
    createMany: prisma.caseFinding.createMany,
    findMany: prisma.caseFinding.findMany,
  };

  afterEach(() => {
    (prisma as any).$transaction = originals.transaction;
    (prisma.caseFinding as any).deleteMany = originals.deleteMany;
    (prisma.caseFinding as any).createMany = originals.createMany;
    (prisma.caseFinding as any).findMany = originals.findMany;
  });

  it("only deletes AI-authored rows (notes === AI_FINDING_NOTE) — a manual finding's WHERE never matches", async () => {
    let deleteWhere: any;
    let created: any[] = [];
    (prisma as any).$transaction = async (fn: any) => fn(prisma);
    (prisma.caseFinding as any).deleteMany = async (args: any) => {
      deleteWhere = args.where;
      return { count: 1 };
    };
    (prisma.caseFinding as any).createMany = async (args: any) => {
      created = args.data;
      return { count: args.data.length };
    };
    (prisma.caseFinding as any).findMany = async () => [
      { id: "manual-1", notes: "Confirmed with the client directly." },
      { id: "ai-2", notes: AI_FINDING_NOTE },
    ];

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

  it("still deletes stale AI rows even when the new batch is empty (nothing left to regenerate)", async () => {
    let deleteWhere: any;
    let createCalled = false;
    (prisma as any).$transaction = async (fn: any) => fn(prisma);
    (prisma.caseFinding as any).deleteMany = async (args: any) => {
      deleteWhere = args.where;
      return { count: 1 };
    };
    (prisma.caseFinding as any).createMany = async () => {
      createCalled = true;
      return { count: 0 };
    };
    (prisma.caseFinding as any).findMany = async () => [];

    await CaseFindingRepo.replaceAiFindings("case-1", []);

    expect(deleteWhere).to.deep.equal({ caseId: "case-1", notes: AI_FINDING_NOTE });
    expect(createCalled).to.equal(false);
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

  it("only deletes AI-authored rows (notes === AI_PROCEDURE_NOTE) — a manual procedure item's WHERE never matches", async () => {
    let deleteWhere: any;
    let created: any[] = [];
    (prisma as any).$transaction = async (fn: any) => fn(prisma);
    (prisma.procedureItem as any).deleteMany = async (args: any) => {
      deleteWhere = args.where;
      return { count: 1 };
    };
    (prisma.procedureItem as any).createMany = async (args: any) => {
      created = args.data;
      return { count: args.data.length };
    };
    (prisma.procedureItem as any).findMany = async () => [
      { id: "manual-1", notes: null },
      { id: "ai-2", notes: AI_PROCEDURE_NOTE },
    ];

    await ProceduralDeadlineRepo.replaceAiProcedureItems("case-1", [
      { kind: "FILING", label: "New AI-found deadline task", sourceLabel: "D02" },
    ]);

    expect(deleteWhere).to.deep.equal({ caseId: "case-1", notes: AI_PROCEDURE_NOTE });
    expect(created).to.have.length(1);
    expect(created[0]).to.deep.include({ caseId: "case-1", notes: AI_PROCEDURE_NOTE, label: "New AI-found deadline task" });
  });
});
