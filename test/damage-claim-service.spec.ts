/** DamageClaimSvc's write path: entries are saved as given, marking one awarded or received ticks
 * its Case Strategy to-dos, a new due date moves them, and an AI proposal only counts once
 * accepted. Repositories are monkeypatched (no live Postgres), same idiom as case-snapshot-outlook.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import DamageClaimSvc from "../src/services/damage-claim.service";
import DamageClaimRepo from "../src/repositories/damage-claim.repository";
import OrganizationRepo from "../src/repositories/organization.repository";
import CaseGraphSvc from "../src/services/case-graph.service";
import ProceduralDeadlineRepo from "../src/repositories/procedural-deadline.repository";
import CaseAccess from "../src/utils/case-access";

type Row = Record<string, any>;

function row(id: string, extra: Row = {}): Row {
  return {
    id,
    caseId: "case-1",
    kind: "DAMAGE",
    title: id,
    description: null,
    amount: null,
    done: false,
    dueDate: null,
    source: "MANUAL",
    accepted: true,
    ...extra,
  };
}

describe("DamageClaimSvc", () => {
  let restore: (() => void)[];
  let rows: Row[];
  let audits: string[];
  let closedTodos: { id: string; reason: string }[];
  let movedDueDates: { id: string; dueDate: Date | null }[];
  let dismissed: string[];

  function patch(target: object, key: string, value: unknown) {
    const original = (target as any)[key];
    (target as any)[key] = value;
    restore.push(() => ((target as any)[key] = original));
  }

  beforeEach(() => {
    restore = [];
    audits = [];
    closedTodos = [];
    movedDueDates = [];
    dismissed = [];
    rows = [
      row("backwages", { title: "Backwages", amount: 486000 }),
      row("moral", { title: "Moral damages", amount: 200000 }),
      row("reinstatement", { kind: "REMEDY", title: "Reinstatement" }),
      row("ai", { title: "Exemplary damages", amount: 100000, source: "AI", accepted: false }),
    ];
    patch(CaseAccess, "assertCanEdit", async () => ({ id: "case-1" }));
    patch(DamageClaimRepo, "list", async () => rows.map((r) => ({ ...r })));
    patch(DamageClaimRepo, "findById", async (id: string) => {
      const found = rows.find((r) => r.id === id);
      return found ? { ...found } : null;
    });
    patch(DamageClaimRepo, "create", async (_caseId: string, data: Row) => {
      const created = row(`new-${rows.length}`, data);
      rows.push(created);
      return { ...created };
    });
    patch(DamageClaimRepo, "update", async (id: string, _caseId: string, data: Row) => {
      const target = rows.find((r) => r.id === id);
      if (!target) return null;
      Object.assign(target, data);
      return { ...target };
    });
    patch(DamageClaimRepo, "delete", async (id: string) => {
      const before = rows.length;
      rows = rows.filter((r) => r.id !== id);
      return rows.length < before;
    });
    patch(DamageClaimRepo, "dismiss", async (_caseId: string, key: string) => void dismissed.push(key));
    patch(CaseGraphSvc, "ensureNode", async () => ({}));
    patch(CaseGraphSvc, "markStale", async () => {});
    patch(OrganizationRepo, "writeAudit", async (entry: { action: string }) => {
      audits.push(entry.action);
    });
    patch(ProceduralDeadlineRepo, "closeLinked", async (_caseId: string, _kind: string, id: string, reason: string) => {
      closedTodos.push({ id, reason });
      return 1;
    });
    patch(ProceduralDeadlineRepo, "setLinkedDueDate", async (_caseId: string, _kind: string, id: string, dueDate: Date | null) => {
      movedDueDates.push({ id, dueDate });
    });
  });

  afterEach(() => restore.reverse().forEach((fn) => fn()));

  it("creates an entry as given, with a cleared description stored as none", async () => {
    const created = await DamageClaimSvc.create("case-1", "user-1", { kind: "REMEDY", title: "Apology", description: "  " });
    expect(created).to.include({ kind: "REMEDY", title: "Apology", description: null });
    expect(audits).to.deep.equal(["damage.create"]);
  });

  it("ticks the entry's Case Strategy to-dos, and audits it, once it is awarded or received", async () => {
    await DamageClaimSvc.update("case-1", "moral", "user-1", { amount: 250000 });
    expect(closedTodos).to.deep.equal([]);
    await DamageClaimSvc.update("case-1", "moral", "user-1", { done: true });
    expect(closedTodos).to.deep.equal([{ id: "moral", reason: "DAMAGE_DONE" }]);
    expect(audits).to.deep.equal(["damage.update", "damage.update", "damage.awarded"]);
  });

  it("moves its to-dos to a new due date, and only when the date changes", async () => {
    const due = new Date("2026-11-15T00:00:00.000Z");
    await DamageClaimSvc.update("case-1", "backwages", "user-1", { dueDate: due });
    await DamageClaimSvc.update("case-1", "backwages", "user-1", { dueDate: new Date(due) });
    await DamageClaimSvc.update("case-1", "backwages", "user-1", { dueDate: null });
    expect(movedDueDates).to.deep.equal([
      { id: "backwages", dueDate: due },
      { id: "backwages", dueDate: null },
    ]);
  });

  it("accepts an AI proposal", async () => {
    const accepted = await DamageClaimSvc.accept("case-1", "ai", "user-1");
    expect(accepted).to.include({ accepted: true });
    expect(audits).to.deep.equal(["damage.accept"]);
  });

  it("dismisses an AI entry the lawyer deletes, but not the lawyer's own", async () => {
    await DamageClaimSvc.delete("case-1", "ai", "user-1");
    await DamageClaimSvc.delete("case-1", "moral", "user-1");
    expect(dismissed).to.deep.equal(["DAMAGE:exemplary damages"]);
    expect(rows.map((r) => r.id)).to.deep.equal(["backwages", "reinstatement"]);
  });

  it("dismisses an AI entry's old name when the lawyer renames it, so a re-read doesn't bring it back", async () => {
    await DamageClaimSvc.update("case-1", "ai", "user-1", { amount: 90000 });
    await DamageClaimSvc.update("case-1", "moral", "user-1", { title: "Moral damages (revised)" });
    expect(dismissed).to.deep.equal([]);
    await DamageClaimSvc.update("case-1", "ai", "user-1", { title: "Exemplary damages (Art. 2229)" });
    expect(dismissed).to.deep.equal(["DAMAGE:exemplary damages"]);
  });

  it("gives chat the accepted entries in the shape it reads, or nothing for a case without any", async () => {
    rows[0]!.dueDate = new Date("2026-11-15T00:00:00.000Z");
    rows[1]!.done = true;
    const ctx = await DamageClaimSvc.chatContext("case-1", "PH");
    expect(ctx).to.include({ currency: "PHP", total: 686000, low: 686000, high: 686000, provisional: false });
    expect(ctx!.heads).to.deep.equal([
      { category: "Damages", label: "Backwages", amount: 486000, status: "not yet awarded", basis: "due 2026-11-15", pendingEvidence: null },
      { category: "Damages", label: "Moral damages", amount: 200000, status: "awarded or received", basis: null, pendingEvidence: null },
      { category: "Remedy", label: "Reinstatement", amount: null, status: "not yet awarded", basis: null, pendingEvidence: null },
    ]);
    rows = [rows[3]!];
    expect(await DamageClaimSvc.chatContext("case-1", "PH")).to.equal(undefined);
  });
});
