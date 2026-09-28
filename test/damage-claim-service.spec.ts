/** DamageClaimSvc's write path: every write recomputes the case's heads, so a derived head
 * (attorney's fees) never goes stale, and it refuses a head the model can't stand behind.
 * Repositories are monkeypatched (no live Postgres), same idiom as case-snapshot-outlook.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import DamageClaimSvc from "../src/services/damage-claim.service";
import DamageClaimRepo from "../src/repositories/damage-claim.repository";
import OrganizationRepo from "../src/repositories/organization.repository";
import CaseGraphSvc from "../src/services/case-graph.service";
import CaseAccess from "../src/utils/case-access";
import HttpError from "../src/utils/http-error";

type Row = Record<string, any>;

function row(id: string, category: string, extra: Row = {}): Row {
  return {
    id,
    caseId: "case-1",
    category,
    label: null,
    description: null,
    amount: null,
    basis: null,
    amountLow: null,
    amountHigh: null,
    status: "PROVISIONAL",
    pendingEvidence: null,
    ...extra,
  };
}

describe("DamageClaimSvc", () => {
  let restore: (() => void)[];
  let rows: Row[];
  let setAmountsCalls: { id: string; amount: number | null }[][];
  let staleIds: string[];
  let audits: string[];

  function patch(target: object, key: string, value: unknown) {
    const original = (target as any)[key];
    (target as any)[key] = value;
    restore.push(() => ((target as any)[key] = original));
  }

  beforeEach(() => {
    restore = [];
    setAmountsCalls = [];
    staleIds = [];
    audits = [];
    rows = [
      row("actual", "ACTUAL", { amount: 486000, basis: { kind: "RATE_X_PERIOD", monthlyRate: 27000, months: 18 } }),
      row("moral", "MORAL", { amount: 200000 }),
      row("fees", "ATTORNEYS_FEES", {
        amount: 68600,
        basis: { kind: "PERCENT_OF", percent: 10, categories: ["ACTUAL", "MORAL"] },
      }),
    ];
    patch(CaseAccess, "assertCanEdit", async () => ({ id: "case-1" }));
    patch(DamageClaimRepo, "list", async () => rows.map((r) => ({ ...r })));
    patch(DamageClaimRepo, "findById", async (id: string) => {
      const found = rows.find((r) => r.id === id);
      return found ? { ...found } : null;
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
    patch(DamageClaimRepo, "setAmounts", async (changes: { id: string; amount: number | null }[]) => {
      setAmountsCalls.push(changes);
      for (const c of changes) rows.find((r) => r.id === c.id)!.amount = c.amount;
    });
    patch(CaseGraphSvc, "markStale", async (_caseId: string, _type: string, id: string) => {
      staleIds.push(id);
    });
    patch(OrganizationRepo, "writeAudit", async (entry: { action: string }) => {
      audits.push(entry.action);
    });
  });

  afterEach(() => restore.reverse().forEach((fn) => fn()));

  it("recomputes the RATE_X_PERIOD head and the fees derived from it in the same request", async () => {
    const updated = await DamageClaimSvc.update("case-1", "actual", "user-1", {
      basis: { kind: "RATE_X_PERIOD", monthlyRate: 30000, months: 18 },
    });

    expect(updated.amount).to.equal(540000);
    expect(rows.find((r) => r.id === "fees")!.amount).to.equal(74000); // 10% of 540,000 + 200,000
    expect(setAmountsCalls.flat().map((c) => c.id).sort()).to.deep.equal(["actual", "fees"]);
    expect(staleIds).to.include("fees");
  });

  it("recomputes the fees when a head they're based on is deleted", async () => {
    await DamageClaimSvc.delete("case-1", "moral", "user-1");
    expect(rows.find((r) => r.id === "fees")!.amount).to.equal(48600);
  });

  it("never rewrites a FIXED head's amount", async () => {
    await DamageClaimSvc.update("case-1", "moral", "user-1", { amount: 250000 });
    expect(setAmountsCalls.flat().map((c) => c.id)).to.not.include("moral");
    expect(rows.find((r) => r.id === "fees")!.amount).to.equal(73600);
  });

  it("audits the move to CERTIFIED", async () => {
    await DamageClaimSvc.update("case-1", "moral", "user-1", { status: "CERTIFIED" });
    expect(audits).to.deep.equal(["damage.update", "damage.certify"]);
  });

  it("refuses CERTIFIED on a head with no amount or period", async () => {
    rows.push(row("empty", "OTHER"));
    const err = await DamageClaimSvc.update("case-1", "empty", "user-1", { status: "CERTIFIED" }).catch((e) => e);
    expect(err).to.be.instanceOf(HttpError);
    expect(err.statusCode).to.equal(400);
    expect(rows.find((r) => r.id === "empty")!.status).to.equal("PROVISIONAL");
  });

  it("refuses a range whose low is above its high, including against the stored value", async () => {
    await DamageClaimSvc.update("case-1", "moral", "user-1", { amountHigh: 100000 });
    const err = await DamageClaimSvc.update("case-1", "moral", "user-1", { amountLow: 150000 }).catch((e) => e);
    expect(err).to.be.instanceOf(HttpError);
    expect(err.statusCode).to.equal(400);
  });

  it("stores a cleared label as null", async () => {
    await DamageClaimSvc.update("case-1", "moral", "user-1", { label: "   " });
    expect(rows.find((r) => r.id === "moral")!.label).to.equal(null);
  });
});
