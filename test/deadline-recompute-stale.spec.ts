/**
 * The Case Strategy panel's deadline guarantees: a recompute that moves a due date drops the
 * confirmations that vouched for the old date, and "recompute stale" runs every graph-flagged
 * deadline without one failure stopping the rest. No DB — statics are monkeypatched.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import CaseAccess from "../src/utils/case-access";
import ProceduralDeadlineRepo from "../src/repositories/procedural-deadline.repository";
import CaseGraphSvc from "../src/services/case-graph.service";
import OrganizationRepo from "../src/repositories/organization.repository";
import ProceduralDeadlineSvc from "../src/services/procedural-deadline.service";
import { computePhilippineDeadline } from "../src/utils/ph-deadline";

const TRIGGER = new Date("2026-01-05T00:00:00Z");
const CORRECT_DUE = computePhilippineDeadline("answer_civil", TRIGGER).computedDueDate;

describe("ProceduralDeadlineSvc recompute + recomputeStale", () => {
  const saved: Record<string, any> = {};
  let stored: Record<string, { id: string; ruleCode: string; triggerDate: Date; computedDueDate: Date }>;
  let cleared: string[];
  let stale: { nodeType: string; refId: string }[];
  const patch = (obj: any, key: string, fn: any) => {
    saved[`${obj.name}.${key}`] = { obj, key, orig: obj[key] };
    obj[key] = fn;
  };

  beforeEach(() => {
    cleared = [];
    stored = {
      moved: { id: "moved", ruleCode: "answer_civil", triggerDate: TRIGGER, computedDueDate: new Date("2030-01-01T00:00:00Z") },
      same: { id: "same", ruleCode: "answer_civil", triggerDate: TRIGGER, computedDueDate: CORRECT_DUE },
      broken: { id: "broken", ruleCode: "no_such_rule", triggerDate: TRIGGER, computedDueDate: CORRECT_DUE },
    };
    stale = [
      { nodeType: "PROCEDURAL_DEADLINE", refId: "moved" },
      { nodeType: "TIMELINE_EVENT", refId: "ignored" },
      { nodeType: "PROCEDURAL_DEADLINE", refId: "broken" },
      { nodeType: "PROCEDURAL_DEADLINE", refId: "same" },
    ];
    patch(CaseAccess, "assertCanEdit", async () => undefined);
    patch(CaseAccess, "resolveTenantCode", async () => "PH");
    patch(CaseGraphSvc, "findIncomingSource", async () => null);
    patch(CaseGraphSvc, "clearStale", async () => undefined);
    patch(CaseGraphSvc, "listStaleForCase", async () => stale);
    patch(OrganizationRepo, "writeAudit", async () => ({}));
    patch(ProceduralDeadlineRepo, "findById", async (id: string) => stored[id] ?? null);
    patch(ProceduralDeadlineRepo, "updateComputed", async (id: string, data: any) => ({ id, ...data }));
    patch(ProceduralDeadlineRepo, "clearConfirmations", async (id: string) => {
      cleared.push(id);
    });
  });

  afterEach(() => {
    for (const { obj, key, orig } of Object.values(saved)) obj[key] = orig;
  });

  it("clears confirmations when the due date moves, and only then", async () => {
    await ProceduralDeadlineSvc.recompute("c", "moved", "u");
    await ProceduralDeadlineSvc.recompute("c", "same", "u");
    expect(cleared).to.deep.equal(["moved"]);
  });

  it("recomputes every stale deadline, skips other node types, and reports a failure without stopping", async () => {
    const result = await ProceduralDeadlineSvc.recomputeStale("c", "u");
    expect(result.recomputed.map((r) => r.id)).to.deep.equal(["moved", "same"]);
    expect(result.failed.map((f) => f.id)).to.deep.equal(["broken"]);
  });
});
