/** Ticking a Case Strategy to-do that was sent from another panel settles that item
 * (ProceduralDeadlineSvc.updateItem → settleSource). Repositories and services are monkeypatched,
 * no live Postgres — same idiom as damage-claim-service.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ProceduralDeadlineSvc from "../src/services/procedural-deadline.service";
import ProceduralDeadlineRepo from "../src/repositories/procedural-deadline.repository";
import CaseFindingRepo from "../src/repositories/case-finding.repository";
import CaseFindingSvc from "../src/services/case-finding.service";
import DamageClaimRepo from "../src/repositories/damage-claim.repository";
import DamageClaimSvc from "../src/services/damage-claim.service";
import WitnessRepo from "../src/repositories/witness.repository";
import WitnessSvc from "../src/services/witness.service";
import CaseAccess from "../src/utils/case-access";
import HttpError from "../src/utils/http-error";

type Row = Record<string, any>;

describe("ProceduralDeadlineSvc.updateItem settles the to-do's source", () => {
  let restore: (() => void)[];
  let todo: Row;
  let calls: { svc: string; id: string; data: Row }[];
  let finding: Row | null;
  let head: Row | null;
  let witness: Row | null;

  function patch(target: object, key: string, value: unknown) {
    const original = (target as any)[key];
    (target as any)[key] = value;
    restore.push(() => ((target as any)[key] = original));
  }

  beforeEach(() => {
    restore = [];
    calls = [];
    finding = { id: "f1", category: "DEFENSE_STRATEGY", tag: "PARTIAL" };
    head = { id: "d1", done: false };
    witness = { id: "w1", statementReceived: false };
    todo = { id: "t1", done: false, sourceKind: "FINDING", sourceId: "f1", sourceKey: null };
    patch(CaseAccess, "assertCanEdit", async () => ({ id: "case-1" }));
    patch(ProceduralDeadlineRepo, "updateProcedureItem", async (_id: string, _caseId: string, data: Row) => Object.assign(todo, data));
    patch(CaseFindingRepo, "find", async () => finding);
    patch(DamageClaimRepo, "findById", async () => head);
    patch(WitnessRepo, "list", async () => (witness ? [witness] : []));
    patch(CaseFindingSvc, "update", async (_c: string, id: string, _u: string, data: Row) => calls.push({ svc: "finding", id, data }));
    patch(DamageClaimSvc, "update", async (_c: string, id: string, _u: string, data: Row) => calls.push({ svc: "damage", id, data }));
    patch(WitnessSvc, "update", async (_c: string, id: string, _u: string, data: Row) => calls.push({ svc: "witness", id, data }));
  });

  afterEach(() => restore.reverse().forEach((fn) => fn()));

  const tick = (source: Row) => {
    Object.assign(todo, source);
    return ProceduralDeadlineSvc.updateItem("case-1", "t1", "user-1", { done: true });
  };

  it("marks a defense Answered, a weakness Closed, an attack Ready and a legal issue Resolved", async () => {
    for (const [category, tag] of [
      ["DEFENSE_STRATEGY", "ANSWERED"],
      ["WEAKNESS", "CLOSED"],
      ["ATTACK_STRATEGY", "READY"],
      ["LEGAL_ISSUE", "RESOLVED"],
    ]) {
      calls = [];
      finding = { id: "f1", category, tag: null };
      await tick({ sourceKind: "FINDING", sourceId: "f1" });
      expect(calls).to.deep.equal([{ svc: "finding", id: "f1", data: { tag } }]);
    }
  });

  it("leaves a strength, and a finding already at its fixed tag, alone", async () => {
    finding = { id: "f1", category: "STRENGTH", tag: "MODERATE" };
    await tick({ sourceKind: "FINDING", sourceId: "f1" });
    finding = { id: "f1", category: "DEFENSE_STRATEGY", tag: "ANSWERED" };
    await tick({ sourceKind: "FINDING", sourceId: "f1" });
    expect(calls).to.deep.equal([]);
  });

  it("marks a Damages & Remedies entry awarded or received, unless it already is", async () => {
    await tick({ sourceKind: "DAMAGE", sourceId: "d1" });
    head = { id: "d1", done: true };
    await tick({ sourceKind: "DAMAGE", sourceId: "d1" });
    expect(calls).to.deep.equal([{ svc: "damage", id: "d1", data: { done: true } }]);
  });

  it("marks a witness's statement received, but leaves items that need a proof document", async () => {
    await tick({ sourceKind: "WITNESS_NEED", sourceId: "w1", sourceKey: "STATEMENT" });
    await tick({ sourceKind: "WITNESS_NEED", sourceId: "w1", sourceKey: "FACTOR_B" });
    expect(calls).to.deep.equal([{ svc: "witness", id: "w1", data: { statementReceived: true } }]);
  });

  it("does nothing on reopen, or for a to-do with no source", async () => {
    Object.assign(todo, { sourceKind: "FINDING", sourceId: "f1" });
    await ProceduralDeadlineSvc.updateItem("case-1", "t1", "user-1", { done: false });
    await tick({ sourceKind: null, sourceId: null });
    expect(calls).to.deep.equal([]);
  });

  it("still ticks the to-do when its source was deleted", async () => {
    patch(CaseFindingSvc, "update", async () => {
      throw new HttpError("Finding not found", 404);
    });
    const row = await tick({ sourceKind: "FINDING", sourceId: "f1" });
    expect(row.done).to.equal(true);
  });
});
